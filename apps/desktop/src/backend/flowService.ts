// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - same boundary as serviceDiscovery.ts: plain filesystem and loopback reads of a process this app does not own, with no Effect service to route them through.
// Reverse state for "quitting the app leaves the service running": Settings has
// to be able to say what the service is doing and to stop or restart it.
//
// The canonical implementation of all of this is `scripts/instances/service.mjs`
// (`serviceStatus`, `restartManaged`) and the `flow service` verbs. The desktop
// cannot call it: a packaged app ships no `scripts/` directory, and running a
// launcher would be the app taking over a lifecycle the service manager owns.
// So this module re-reads the same three facts — is a unit installed, has the
// service manager loaded it, what is the instance doing — from the unit file,
// one service-manager query, and the instance registry.
//
// It never installs, writes or repairs anything. Stopping is a request to the
// supervisor's control API; restarting is delegated to the service manager, and
// is simply refused when no service manager owns the unit.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DesktopFlowServiceActionResult, DesktopFlowServiceStatus } from "@t3tools/contracts";

import {
  desktopServiceRegistryRoot,
  discoverService,
  readServiceControl,
} from "./serviceDiscovery.ts";

// Kept in sync with `scripts/instances/service.mjs`; the label is part of the
// on-disk contract, so both sides must name it identically.
export const LAUNCHD_LABEL = "com.flow.service";
export const SYSTEMD_UNIT = "flow.service";

const CONTROL_TIMEOUT_MS = 5_000;
const RUNNER_TIMEOUT_MS = 10_000;

export interface ServiceProcessResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Every service-manager call goes through this, so tests assert the exact
    argv instead of executing `launchctl` or `systemctl`. */
export type ServiceProcessRunner = (
  command: string,
  args: readonly string[],
) => Promise<ServiceProcessResult>;

const defaultRunner: ServiceProcessRunner = (command, args) =>
  new Promise((resolvePromise) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: RUNNER_TIMEOUT_MS },
      (error, stdout, stderr) =>
        resolvePromise({
          ok: !error,
          stdout: stdout || "",
          stderr: stderr || String(error?.message ?? ""),
        }),
    );
  });

/** `host` and `uid` are passed in rather than read from `process`: this module
    is plain async code, and the Effect layer above it already resolves both
    from `HostProcessPlatform`/`HostProcessUserId`, which tests override. */
export interface FlowServiceInput {
  readonly host: NodeJS.Platform;
  readonly uid: number;
  readonly registryRoot?: string;
  readonly name?: string;
  readonly homeDirectory?: string;
  readonly run?: ServiceProcessRunner;
  readonly fetch?: typeof globalThis.fetch;
}

interface ResolvedInput {
  readonly registryRoot: string;
  readonly name: string;
  readonly label: string;
  readonly unitPath: string;
  readonly host: NodeJS.Platform;
  readonly uid: number;
  readonly run: ServiceProcessRunner;
  readonly fetchImpl: typeof globalThis.fetch;
}

/** Mirrors `unitLocation()` in `scripts/instances/service.mjs`. */
export const unitLocation = ({
  homeDirectory = NodeOS.homedir(),
  host,
}: {
  readonly homeDirectory?: string;
  readonly host: NodeJS.Platform;
}): {
  readonly label: string;
  readonly path: string;
} =>
  host === "darwin"
    ? {
        label: LAUNCHD_LABEL,
        path: NodePath.join(homeDirectory, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      }
    : {
        label: SYSTEMD_UNIT,
        path: NodePath.join(homeDirectory, ".config/systemd/user", SYSTEMD_UNIT),
      };

const resolveInput = (input: FlowServiceInput): ResolvedInput => {
  const host = input.host;
  const location = unitLocation(
    input.homeDirectory === undefined ? { host } : { homeDirectory: input.homeDirectory, host },
  );
  return {
    registryRoot: input.registryRoot ?? desktopServiceRegistryRoot(),
    name: input.name ?? "primary",
    label: location.label,
    unitPath: location.path,
    host,
    uid: input.uid,
    run: input.run ?? defaultRunner,
    fetchImpl: input.fetch ?? globalThis.fetch,
  };
};

const launchdTarget = (resolved: ResolvedInput) => `gui/${String(resolved.uid)}/${resolved.label}`;

// Unreadable is reported as absent rather than thrown: the panel's job is to
// describe the service, and a status read must never fail the renderer.
const readUnit = async (path: string): Promise<string | null> => {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch {
    return null;
  }
};

/** launchd plist `ProgramArguments`, or a systemd `ExecStart=` line. Only the
    launch argv is parsed; nothing else in the unit is interpreted here. */
export const parseUnitArguments = (unit: string, host: NodeJS.Platform): readonly string[] => {
  if (host === "darwin") {
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(unit);
    if (!block) return [];
    return [...block[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
      match[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
    );
  }
  const line = /^ExecStart=(.*)$/m.exec(unit);
  if (!line) return [];
  // `quoteSystemdValue` only ever double-quotes, with backslash escapes inside.
  const tokens = [...line[1]!.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) =>
    match[1] === undefined ? match[2]! : match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\"),
  );
  return tokens.map((token) => token.replaceAll("%%", "%"));
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await NodeFSP.stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether the installed unit still launches *this* installation's supervisor.
 *
 * `scripts/instances/service.mjs` decides the same question by re-rendering the
 * unit it would write today and comparing the text. That needs the release
 * layout and the private node path, neither of which a packaged desktop knows,
 * so this checks the two facts the unit itself carries: that it supervises this
 * registry's instance directory, and that the entry point it names still exists.
 * A unit left behind by a removed checkout, or pointed at another registry,
 * fails the check exactly as it does in the CLI.
 */
const isUnitCurrent = async (unit: string, resolved: ResolvedInput): Promise<boolean> => {
  const argv = parseUnitArguments(unit, resolved.host);
  const superviseIndex = argv.indexOf("--supervise");
  if (superviseIndex < 0 || argv.length <= superviseIndex + 1) return false;
  const directory = NodePath.join(
    NodePath.resolve(resolved.registryRoot),
    "instances",
    resolved.name,
  );
  if (NodePath.resolve(argv[superviseIndex + 1]!) !== directory) return false;
  const entry = argv[1];
  return entry !== undefined && (await exists(entry));
};

const isUnitLoaded = async (resolved: ResolvedInput): Promise<boolean> => {
  if (resolved.host === "darwin") {
    return (await resolved.run("launchctl", ["print", launchdTarget(resolved)])).ok;
  }
  return (await resolved.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT])).ok;
};

export const readFlowServiceStatus = async (
  input: FlowServiceInput,
): Promise<DesktopFlowServiceStatus> => {
  const resolved = resolveInput(input);
  const [unit, discovery] = await Promise.all([
    readUnit(resolved.unitPath),
    discoverService({
      registryRoot: resolved.registryRoot,
      name: resolved.name,
      fetch: resolved.fetchImpl,
    }),
  ]);
  // Asked even when no unit file is present: a unit removed without a
  // `bootout` leaves the service manager still running the job, and a panel
  // that hid that would be lying about what owns the server.
  const loaded = await isUnitLoaded(resolved);
  return {
    installed: unit !== null,
    loaded,
    current: unit === null ? false : await isUnitCurrent(unit, resolved),
    label: resolved.label,
    unitPath: resolved.unitPath,
    instance: {
      // Discovery's status vocabulary is the phase vocabulary the panel renders.
      phase: discovery.status,
      environmentId: discovery.environmentId ?? null,
      dataHome: discovery.dataHome ?? null,
      serverOrigin: discovery.serverOrigin ?? null,
      error: discovery.reason ?? null,
    },
  };
};

const failed = (reason: "not-managed" | "not-running" | "failed", detail: string | null) =>
  ({ ok: false, reason, detail }) satisfies DesktopFlowServiceActionResult;

export const stopFlowService = async (
  input: FlowServiceInput,
): Promise<DesktopFlowServiceActionResult> => {
  const resolved = resolveInput(input);
  const control = await readServiceControl({
    registryRoot: resolved.registryRoot,
    name: resolved.name,
  });
  // No published control endpoint means no supervisor is running. Stopping an
  // already-stopped service is not an error the user needs to see as a failure,
  // but the caller still learns nothing happened.
  if (control === null) return failed("not-running", null);
  try {
    const response = await resolved.fetchImpl(new URL("/stop", control.url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      headers: { authorization: `Bearer ${control.token}` },
    });
    if (!response.ok) return failed("failed", "The service refused the stop request.");
    return { ok: true, reason: null, detail: null };
  } catch (cause) {
    return failed("failed", cause instanceof Error ? cause.message : String(cause));
  }
};

export const restartFlowService = async (
  input: FlowServiceInput,
): Promise<DesktopFlowServiceActionResult> => {
  const resolved = resolveInput(input);
  // Only the service manager restarts the service. The desktop deliberately
  // has no path that spawns a supervisor: that would race the manager for the
  // supervisor lock, and an app-owned server is the thing this work removed.
  if (!(await isUnitLoaded(resolved))) return failed("not-managed", null);
  const result =
    resolved.host === "darwin"
      ? await resolved.run("launchctl", ["kickstart", "-k", launchdTarget(resolved)])
      : await resolved.run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  if (!result.ok) return failed("failed", result.stderr.trim() || null);
  return { ok: true, reason: null, detail: null };
};

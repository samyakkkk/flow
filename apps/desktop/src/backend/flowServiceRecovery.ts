// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - the same
// boundary as DesktopServiceAdoption.ts and flowService.ts: plain filesystem
// reads of a journal this app wrote, and one shot of the service's own CLI.
// There is no server of ours to route either through.
//
// What a desktop that could not attach can still do, without a server:
//
//   - read the adoption journal, so the recovery screen can show how far
//     first-launch setup got;
//   - mint a standard-scope pairing URL against the service's own data home
//     the way `t3 pair` does, so an app too old for the service can still hand
//     the user a working browser session;
//   - leave a one-shot marker asking the next launch to use the built-in
//     server, because Electron's `app.relaunch` cannot carry an environment
//     variable (RelaunchOptions is `{ args, execPath }` only, electron 43).
//
// The pairing credential never crosses the IPC boundary: it is minted here and
// handed straight to the OS browser.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { DesktopFlowServiceAdoption } from "@t3tools/contracts";

import { resolveAdoptionPaths } from "./DesktopServiceAdoption.ts";
import { legacyBaseDirProbePath } from "@t3tools/shared/homeBaseDir";
import { desktopServiceRegistryRoot, discoverService } from "./serviceDiscovery.ts";

/** One-shot request for the next launch to use the private-child backend.
    Consumed (and deleted) by the backend pool before it decides which primary
    to build, so "continue with the built-in server" survives exactly one
    relaunch and never becomes a sticky mode the user cannot leave. */
export const LEGACY_BACKEND_MARKER_FILE = "legacy-backend-once";

const MINT_TIMEOUT_MS = 20_000;

export interface RecoveryEnvironment {
  readonly homeDirectory: string;
  readonly stateDir: string;
  readonly executablePath: string;
  readonly backendEntryPath: string;
  readonly backendCwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
};

const adoptionJournalPath = async (environment: RecoveryEnvironment): Promise<string> => {
  const env = environment.env ?? process.env;
  return resolveAdoptionPaths({
    homeDirectory: environment.homeDirectory,
    env,
    legacyHomeExists: await exists(
      legacyBaseDirProbePath(environment.homeDirectory, NodePath.join),
    ),
  }).journalPath;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The journal as the renderer needs it: an outcome, an ordered step list and
    the failure, with every unknown shape collapsing to `null` rather than
    throwing. A screen that cannot read the journal still has to render. */
export const readFlowServiceAdoption = async (
  environment: RecoveryEnvironment,
): Promise<DesktopFlowServiceAdoption | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await NodeFSP.readFile(await adoptionJournalPath(environment), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const outcome = parsed.outcome;
  if (outcome !== "in-progress" && outcome !== "adopted" && outcome !== "failed") return null;
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const failure = isRecord(parsed.failure) ? parsed.failure : null;
  return {
    outcome,
    steps: steps.flatMap((step) =>
      isRecord(step) && typeof step.name === "string"
        ? [
            {
              name: step.name,
              ok: step.ok === true,
              detail: typeof step.detail === "string" ? step.detail : null,
            },
          ]
        : [],
    ),
    failure:
      failure && typeof failure.step === "string" && typeof failure.message === "string"
        ? { step: failure.step, message: failure.message }
        : null,
  };
};

export interface MintedPairingUrl {
  readonly ok: boolean;
  /** Present only on success. Never returned across IPC — see the file header. */
  readonly pairingUrl?: string;
  readonly detail?: string;
}

const runPair = (environment: RecoveryEnvironment, dataHome: string): Promise<MintedPairingUrl> =>
  new Promise((resolvePromise) => {
    NodeChildProcess.execFile(
      environment.executablePath,
      [environment.backendEntryPath, "pair", "--base-dir", dataHome, "--json"],
      {
        cwd: environment.backendCwd,
        timeout: MINT_TIMEOUT_MS,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            ok: false,
            detail: `${error.message}${stderr ? `: ${stderr}` : ""}`.slice(-2000),
          });
          return;
        }
        let pairingUrl: unknown;
        try {
          pairingUrl = (JSON.parse(stdout) as { readonly pairingUrl?: unknown }).pairingUrl;
        } catch (cause) {
          resolvePromise({
            ok: false,
            detail: `Could not read the pairing output: ${String(cause)}`,
          });
          return;
        }
        if (typeof pairingUrl !== "string" || pairingUrl.length === 0) {
          resolvePromise({ ok: false, detail: "The pairing output contained no URL." });
          return;
        }
        resolvePromise({ ok: true, pairingUrl });
      },
    );
  });

/**
 * A standard-scope pairing URL for the running service, minted the way
 * `t3 pair` mints one: run the service's own entry against its data home, so
 * the auth database and the pairing base URL are the service's, not this
 * app's. Administrative scopes are deliberately not used — a browser session
 * is a client, not the app's own attach.
 */
export const mintServicePairingUrl = async (
  environment: RecoveryEnvironment,
): Promise<MintedPairingUrl> => {
  const env = environment.env ?? process.env;
  const discovery = await discoverService({
    registryRoot: desktopServiceRegistryRoot({
      env: env as NodeJS.ProcessEnv,
      homeDirectory: environment.homeDirectory,
    }),
  });
  if (discovery.status !== "ready" || discovery.dataHome === undefined) {
    return {
      ok: false,
      detail:
        discovery.reason ??
        `The Flow service is not running (${discovery.status}), so there is nothing to open.`,
    };
  }
  return runPair(environment, discovery.dataHome);
};

export const legacyBackendMarkerPath = (stateDir: string): string =>
  NodePath.join(stateDir, LEGACY_BACKEND_MARKER_FILE);

export const requestLegacyBackendOnNextLaunch = async (stateDir: string): Promise<void> => {
  const path = legacyBackendMarkerPath(stateDir);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
};

/** Reads the marker and removes it in the same call: one relaunch, not a mode.
    Synchronous because the backend pool consults it while deciding which
    primary to build, before anything else can observe the choice. */
export const consumeLegacyBackendMarker = (stateDir: string): boolean => {
  // No state directory means nothing could have written a marker. This runs
  // during pool construction, where an unusable path must read as "attach
  // normally" rather than take the app down.
  if (typeof stateDir !== "string" || stateDir.length === 0) return false;
  try {
    NodeFS.rmSync(legacyBackendMarkerPath(stateDir));
    return true;
  } catch {
    return false;
  }
};

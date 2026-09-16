// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - this is a filesystem-shaped port of a plain-JS module; it runs before any Effect service exists and must stay a line-for-line match of the canonical implementation.
// Port of `scripts/instances/service-discovery.mjs` (`discoverService`), which
// stays the canonical implementation: the `flow` CLI and the launcher read the
// registry through it, and any change to the on-disk contract belongs there
// first. This copy exists because the desktop cannot import it — the package
// typechecks with `allowJs` off under NodeNext, and the bundled main process
// must not reach outside `apps/desktop` for runtime code. Keep the status
// vocabulary and the disqualification rules identical; the one addition is
// `serverOrigin`, which the canonical module deliberately withholds from CLI
// JSON output but an attaching desktop needs in order to dial the server.
//
// Discovery never starts, stops, migrates or repairs an installation. An
// unreachable owner is not permission to start another server.

import * as NodeFS from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ServiceStatus =
  | "not-configured"
  | "invalid"
  | "incompatible"
  | "stopped"
  | "unreachable"
  | "starting"
  | "ready"
  | "stopping"
  | "failed";

export interface ServiceDiscoveryResult {
  readonly status: ServiceStatus;
  readonly environmentId?: string;
  readonly dataHome?: string;
  readonly runningCode?: string;
  // The server's own HTTP origin, reported by a live supervisor's `/status`.
  // Present only once the service reaches `ready`.
  readonly serverOrigin?: string;
  readonly reason?: string;
}

// Where the desktop's service lives, and the single source of truth for it:
// first-launch adoption installs into this registry (DesktopServiceAdoption)
// and attaching reads from it, so the two can never point at different
// installations.
//
// The desktop's service is always the installed Flow *release*, which puts its
// registry at `<FLOW_RELEASE_HOME>/instance-home` (`flow-release.mjs` defaults
// FLOW_INSTANCE_HOME to exactly that before handing off to the launcher).
// There is deliberately no fallback to `launcher.mjs`'s own
// `~/.local/share/flow-app` default: that is the registry a *source checkout*
// manages, and silently attaching to it would let a dev tree and a release
// fight over one app. A developer who wants that registry sets
// FLOW_INSTANCE_HOME, which is what `flow dev` already does.
export const desktopServiceRegistryRoot = ({
  env = process.env,
  homeDirectory = homedir(),
}: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
} = {}): string =>
  resolve(
    env.FLOW_INSTANCE_HOME ||
      join(
        env.FLOW_RELEASE_HOME || join(homeDirectory, ".local/share/flow-browser"),
        "instance-home",
      ),
  );

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await NodeFS.readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export interface DiscoverServiceInput {
  readonly registryRoot: string;
  readonly name?: string;
  readonly timeoutMs?: number;
  // Injected by tests so the control request can be driven without a
  // supervisor; production passes nothing and uses global fetch.
  readonly fetch?: typeof globalThis.fetch;
}

/** The service's unauthenticated environment descriptor. Lives here rather
    than in the Effect layer above because it is the same kind of plain probe
    as `/status`: a raw HTTP read of a process this app does not own. */
export const fetchEnvironmentDescriptor = async (
  httpBaseUrl: URL,
  timeoutMs = 5_000,
): Promise<unknown> => {
  const response = await fetch(new URL("/.well-known/t3/environment", httpBaseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Descriptor request failed with ${String(response.status)}.`);
  return (await response.json()) as unknown;
};

/** The control endpoint of a live supervisor, or null when no supervisor has
    published one. Same-user file trust, the model `flow` itself uses: whoever
    can read `runtime.json` is already the owner of this installation. The
    token stays inside this module's callers — it is never part of a discovery
    result, and never crosses the IPC boundary. */
export const readServiceControl = async ({
  registryRoot,
  name = "primary",
}: {
  readonly registryRoot: string;
  readonly name?: string;
}): Promise<{ readonly url: URL; readonly token: string } | null> => {
  const directory = join(resolve(registryRoot), "instances", name);
  let runtime: unknown;
  try {
    runtime = await readJson(join(directory, "runtime.json"));
  } catch {
    return null;
  }
  if (!isRecord(runtime) || !nonEmptyString(runtime.token)) return null;
  try {
    const url = new URL(String(runtime.controlUrl));
    // Identical to the guard `discoverService` applies below: a control URL is
    // only ever a loopback origin, never a credentialed or pathed address.
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return { url, token: runtime.token };
  } catch {
    return null;
  }
};

export const discoverService = async ({
  registryRoot,
  name = "primary",
  timeoutMs = 3_000,
  fetch: fetchImpl = globalThis.fetch,
}: DiscoverServiceInput): Promise<ServiceDiscoveryResult> => {
  const directory = join(resolve(registryRoot), "instances", name);
  let config: unknown;
  let runtime: unknown;
  try {
    config = await readJson(join(directory, "config.json"));
    runtime = await readJson(join(directory, "runtime.json"));
  } catch {
    return { status: "invalid", reason: "Unreadable service metadata." };
  }
  if (!isRecord(config)) return { status: runtime ? "invalid" : "not-configured" };
  if (config.version !== 1)
    return { status: "incompatible", reason: "Unsupported instance metadata version." };
  if (
    !nonEmptyString(config.id) ||
    config.name !== name ||
    config.dev ||
    config.mode !== "isolated" ||
    !nonEmptyString(config.home) ||
    typeof config.code !== "string"
  )
    return { status: "invalid", reason: "Not a standalone primary service." };
  // The recorded home is the identity: a service may legitimately own data
  // outside its instance directory. Only its absence disqualifies it, because
  // discovery must never invent a home it did not find.
  try {
    await NodeFS.realpath(config.home);
  } catch {
    return { status: "invalid", reason: "Service data directory is unavailable." };
  }
  const identity = {
    environmentId: config.id,
    dataHome: config.home,
    runningCode: config.code,
  } as const;
  if (!isRecord(runtime)) return { ...identity, status: "stopped" };
  let url: URL;
  try {
    url = new URL(String(runtime.controlUrl));
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      runtime.id !== config.id ||
      !nonEmptyString(runtime.generation) ||
      !nonEmptyString(runtime.token)
    )
      throw new Error("invalid");
  } catch {
    return { ...identity, status: "invalid", reason: "Invalid service control identity." };
  }
  try {
    const response = await fetchImpl(new URL("/status", url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${String(runtime.token)}` },
    });
    if (!response.ok)
      return { ...identity, status: "unreachable", reason: "Service rejected the status request." };
    const live: unknown = await response.json();
    if (!isRecord(live) || live.id !== config.id || live.generation !== runtime.generation)
      return {
        ...identity,
        status: "invalid",
        reason: "Live service identity does not match this installation.",
      };
    const phase = live.phase;
    if (phase !== "starting" && phase !== "ready" && phase !== "stopping" && phase !== "failed")
      return {
        ...identity,
        status: "incompatible",
        reason: "Unsupported service lifecycle state.",
      };
    // The control token and control URL belong to the lifecycle owner and are
    // never forwarded; the server origin is the one field a client needs.
    return {
      ...identity,
      status: phase,
      ...(nonEmptyString(live.origin) ? { serverOrigin: live.origin } : {}),
    };
  } catch {
    return { ...identity, status: "unreachable", reason: "Service could not be reached." };
  }
};

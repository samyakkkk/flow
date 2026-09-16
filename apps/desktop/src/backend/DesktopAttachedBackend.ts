// @effect-diagnostics nodeBuiltinImport:off - minting runs the service's own CLI as a one-shot child at the process boundary; there is no server of ours to spawn through the managed spawner.
// The desktop attaches to the `flow` service instead of spawning a server of
// its own. One persistent service owns the database, the brain and every
// external coding session's capture endpoint; the app is just another client
// of it, and quitting the app must leave all of that running.
//
// This is a second `DesktopBackendInstance` implementation next to
// `makeBackendInstance` (DesktopBackendManager.ts). It deliberately shares no
// machinery with it: there is no child process to supervise, so there is no
// restart loop, no output capture, no telemetry fds and — importantly — no
// process `Scope`. `DesktopBackendPool` closes an instance's scope to stop it;
// an attached instance holding one would drag the shared service down with the
// app.
//
// The credential story is `t3 pair`, not a new endpoint: the desktop runs the
// service's own backend entry as `pair --base-dir <dataHome> --admin --json`,
// which opens the service's auth database from a second process and mints an
// administrative pairing credential. Trust is the filesystem, the same model
// the `flow` CLI already uses. Minting spawns a process, so it cannot happen
// inside `currentConfig`: the renderer bridge reads that over a *synchronous*
// IPC channel, and an async Effect there is an uncaught AsyncFiberError in the
// main process. Instead the config carries no token and `mintBootstrapCredential`
// mints one on request; `DesktopLocalEnvironmentAuth` exchanges it for the
// bearer the renderer uses on every request, so single-use is fine.

import * as NodeChildProcess from "node:child_process";

import { DESKTOP_PROTOCOL, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import {
  desktopServiceRegistryRoot,
  discoverService,
  fetchEnvironmentDescriptor,
  type ServiceDiscoveryResult,
} from "./serviceDiscovery.ts";

// The desktop-attach protocol generations this build can talk to. `max` tracks
// the contract so a desktop never claims to understand a generation the
// shipped schema does not describe; `min` moves only when support for an older
// generation is actually dropped.
export const DESKTOP_PROTOCOL_SUPPORTED = { min: 1, max: DESKTOP_PROTOCOL } as const;

const DESCRIPTOR_TIMEOUT = Duration.seconds(5);
// A service reporting `starting` is mid-boot. Wait as long as the supervisor's
// own readiness deadline (120s, supervisor.mjs) so a slow first boot is never
// reported as a broken service.
const STARTING_POLL_INTERVAL = Duration.millis(250);
const STARTING_MAX_POLLS = 480;
const MINT_TIMEOUT_MS = 20_000;

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-attached-backend");

const decodeDescriptor = Schema.decodeUnknownOption(ExecutionEnvironmentDescriptor);

export class AttachProbeError extends Schema.TaggedErrorClass<AttachProbeError>()(
  "AttachProbeError",
  { detail: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface AttachedBackendEnvironment {
  readonly executablePath: string;
  readonly backendEntryPath: string;
  readonly backendCwd: string;
}

export interface AttachedBackendSpec {
  readonly id: DesktopBackendManager.BackendInstanceId;
  readonly label: Effect.Effect<string>;
  readonly environment: AttachedBackendEnvironment;
  readonly onReady?: (httpBaseUrl: URL) => Effect.Effect<void>;
  readonly onShutdown?: () => Effect.Effect<void>;
  // Returning true asks for one more attach attempt (the user pressed retry,
  // or the caller fixed something). False leaves the instance failed.
  readonly onPreflightFailed?: (
    failure: DesktopBackendManager.PreflightFailure,
  ) => Effect.Effect<boolean>;
  readonly registryRoot?: string;
  readonly serviceName?: string;
  // Seams for tests. Production uses the real registry, a real descriptor
  // request and a spawned `pair` process.
  readonly discover?: () => Effect.Effect<ServiceDiscoveryResult>;
  readonly fetchDescriptor?: (httpBaseUrl: URL) => Effect.Effect<unknown, AttachProbeError>;
  readonly mintCredential?: (input: {
    readonly dataHome: string;
  }) => Effect.Effect<string, AttachProbeError>;
}

const failure = (
  kind: DesktopBackendManager.AttachFailureKind,
  reason: string,
  detail: string,
): DesktopBackendManager.PreflightFailure => ({
  reason,
  fatal: true,
  attach: { kind, detail },
});

interface AttachSuccess {
  readonly _tag: "attached";
  readonly httpBaseUrl: URL;
  readonly dataHome: string;
}

interface AttachFailed {
  readonly _tag: "failed";
  readonly failure: DesktopBackendManager.PreflightFailure;
}

type AttachOutcome = AttachSuccess | AttachFailed;

const parseOrigin = (origin: string | undefined): Option.Option<URL> => {
  if (origin === undefined) return Option.none();
  try {
    return Option.some(new URL(origin));
  } catch {
    return Option.none();
  }
};

/** `discoverService` status -> failure ladder. Never starts or installs
    anything: that is the service layer's job, not a client's. */
const statusFailure = (
  result: ServiceDiscoveryResult,
): DesktopBackendManager.PreflightFailure | undefined => {
  const detail = result.reason ?? `Service status: ${result.status}.`;
  switch (result.status) {
    case "not-configured":
      return failure("not-installed", "The Flow service is not installed yet.", detail);
    case "stopped":
    case "stopping":
    case "failed":
      return failure("stopped", "The Flow service is not running.", detail);
    case "unreachable":
      return failure("unreachable", "The Flow service did not answer.", detail);
    case "invalid":
    case "incompatible":
      return failure("incompatible", "The Flow service needs to be updated.", detail);
    default:
      return undefined;
  }
};

/** Mint an administrative pairing credential out of the service's own auth
    database by running its backend entry's `pair` command. See the file header
    for why this and not a control endpoint. */
const defaultMintCredential =
  (environment: AttachedBackendEnvironment) =>
  (input: { readonly dataHome: string }): Effect.Effect<string, AttachProbeError> =>
    Effect.tryPromise({
      try: () =>
        new Promise<string>((resolvePromise, rejectPromise) => {
          NodeChildProcess.execFile(
            environment.executablePath,
            [
              environment.backendEntryPath,
              "pair",
              "--base-dir",
              input.dataHome,
              "--admin",
              "--json",
            ],
            {
              cwd: environment.backendCwd,
              timeout: MINT_TIMEOUT_MS,
              env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            },
            (error, stdout, stderr) => {
              if (error) {
                rejectPromise(new Error(`${error.message}${stderr ? `: ${stderr}` : ""}`));
                return;
              }
              let credential: unknown;
              try {
                credential = (JSON.parse(stdout) as { readonly credential?: unknown }).credential;
              } catch (cause) {
                rejectPromise(new Error(`Could not parse pairing output: ${String(cause)}`));
                return;
              }
              if (typeof credential !== "string" || credential.length === 0) {
                rejectPromise(new Error("Pairing output did not contain a credential."));
                return;
              }
              resolvePromise(credential);
            },
          );
        }),
      catch: (cause) =>
        new AttachProbeError({
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

/** Unauthenticated descriptor read. The request itself lives in
    `serviceDiscovery.ts` next to the other raw probes of the service, so an
    attached instance carries no service requirements of its own; tests replace
    this wholesale through the spec. */
const defaultFetchDescriptor = (httpBaseUrl: URL): Effect.Effect<unknown, AttachProbeError> =>
  Effect.tryPromise({
    try: () => fetchEnvironmentDescriptor(httpBaseUrl, Duration.toMillis(DESCRIPTOR_TIMEOUT)),
    catch: (cause) =>
      new AttachProbeError({
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

export const makeAttachedBackendInstance = Effect.fn("desktop.attachedBackend.make")(function* (
  spec: AttachedBackendSpec,
) {
  const registryRoot = spec.registryRoot ?? desktopServiceRegistryRoot();
  const serviceName = spec.serviceName ?? "primary";
  const discover =
    spec.discover ??
    (() => Effect.promise(() => discoverService({ registryRoot, name: serviceName })));
  const fetchDescriptor = spec.fetchDescriptor ?? defaultFetchDescriptor;
  const mintCredential = spec.mintCredential ?? defaultMintCredential(spec.environment);

  const desiredRunning = yield* Ref.make(false);
  const ready = yield* Ref.make(false);
  const attached = yield* Ref.make(Option.none<AttachSuccess>());
  const parkedFailure = yield* Ref.make(Option.none<DesktopBackendManager.PreflightFailure>());

  const checkCompatibility = (
    httpBaseUrl: URL,
  ): Effect.Effect<Option.Option<DesktopBackendManager.PreflightFailure>> =>
    Effect.gen(function* () {
      const payload = yield* Effect.result(fetchDescriptor(httpBaseUrl));
      if (Result.isFailure(payload))
        return Option.some(
          failure("unreachable", "The Flow service did not answer.", payload.failure.detail),
        );
      const descriptor = decodeDescriptor(payload.success);
      // A malformed `desktopProtocol` fails the whole decode. That is the
      // same signal as an absent one — the server cannot state a generation
      // this build understands — so both land on "update the service".
      if (Option.isNone(descriptor))
        return Option.some(
          failure(
            "incompatible",
            "The Flow service needs to be updated.",
            "Its environment descriptor could not be read.",
          ),
        );
      const generation = descriptor.value.desktopProtocol;
      if (generation === undefined)
        return Option.some(
          failure(
            "incompatible",
            "The Flow service needs to be updated.",
            "It does not report a desktop-attach protocol generation.",
          ),
        );
      if (
        generation < DESKTOP_PROTOCOL_SUPPORTED.min ||
        generation > DESKTOP_PROTOCOL_SUPPORTED.max
      )
        return Option.some(
          failure(
            "incompatible",
            "The Flow service needs to be updated.",
            `It speaks desktop-attach generation ${String(generation)}; this app supports ${String(DESKTOP_PROTOCOL_SUPPORTED.min)} through ${String(DESKTOP_PROTOCOL_SUPPORTED.max)}.`,
          ),
        );
      return Option.none<DesktopBackendManager.PreflightFailure>();
    });

  // A service that is still booting is polled rather than rejected; anything
  // else is decided on the first look. None means it never settled — the
  // supervisor's own readiness deadline is 120s, so waiting a while is the
  // difference between attaching and calling a healthy service broken.
  const discoverSettled = Effect.gen(function* () {
    for (let poll = 0; poll < STARTING_MAX_POLLS; poll += 1) {
      const result = yield* discover();
      if (result.status !== "starting") return Option.some(result);
      yield* Effect.sleep(STARTING_POLL_INTERVAL);
    }
    return Option.none<ServiceDiscoveryResult>();
  });

  const attempt: Effect.Effect<AttachOutcome> = Effect.gen(function* () {
    const settled = yield* discoverSettled;
    if (Option.isNone(settled))
      return {
        _tag: "failed",
        failure: failure(
          "unreachable",
          "The Flow service is still starting.",
          "It did not become ready before the attach deadline.",
        ),
      } satisfies AttachFailed;
    const result = settled.value;
    const ladder = statusFailure(result);
    if (ladder !== undefined) return { _tag: "failed", failure: ladder } satisfies AttachFailed;
    const origin = parseOrigin(result.serverOrigin);
    if (Option.isNone(origin) || result.dataHome === undefined)
      return {
        _tag: "failed",
        failure: failure(
          "incompatible",
          "The Flow service needs to be updated.",
          "It is ready but did not report an address to connect to.",
        ),
      } satisfies AttachFailed;
    const incompatible = yield* checkCompatibility(origin.value);
    if (Option.isSome(incompatible))
      return { _tag: "failed", failure: incompatible.value } satisfies AttachFailed;
    return {
      _tag: "attached",
      httpBaseUrl: origin.value,
      dataHome: result.dataHome,
    } satisfies AttachSuccess;
  });

  // Attaching has no restart loop of its own: a failed attach parks the
  // instance with its reason, and the UI (via onPreflightFailed returning
  // true) drives the retry.
  const start = Effect.gen(function* () {
    yield* Ref.set(desiredRunning, true);
    for (;;) {
      const outcome = yield* attempt;
      if (outcome._tag === "attached") {
        yield* Ref.set(attached, Option.some(outcome));
        yield* Ref.set(parkedFailure, Option.none());
        yield* Ref.set(ready, true);
        yield* spec.onReady?.(outcome.httpBaseUrl) ?? Effect.void;
        return;
      }
      yield* Ref.set(attached, Option.none());
      yield* Ref.set(parkedFailure, Option.some(outcome.failure));
      yield* Ref.set(ready, false);
      yield* logWarning("could not attach to the Flow service", {
        kind: outcome.failure.attach?.kind ?? "unknown",
        detail: outcome.failure.attach?.detail ?? outcome.failure.reason,
      });
      yield* spec.onShutdown?.() ?? Effect.void;
      const retry = yield* spec.onPreflightFailed?.(outcome.failure) ?? Effect.succeed(false);
      if (!retry) return;
    }
  }).pipe(Effect.withSpan("desktop.attachedBackend.start"));

  // No-op on the service itself, on purpose. `DesktopApp`'s quit finalizer
  // and `DesktopUpdates`' pre-install stop both skip detached instances;
  // this keeps any future caller honest too.
  const stop = () =>
    Effect.gen(function* () {
      yield* Ref.set(desiredRunning, false);
      yield* Ref.set(ready, false);
    });

  const buildConfig = (
    httpBaseUrl: URL,
    credential: string,
    preflightFailure: Option.Option<DesktopBackendManager.PreflightFailure>,
  ): DesktopBackendManager.DesktopBackendStartConfig => ({
    // Process fields describe the service's entry rather than a child of
    // ours. Nothing spawns from this config; they exist because consumers
    // and error text read them.
    executablePath: spec.environment.executablePath,
    entryPath: spec.environment.backendEntryPath,
    cwd: spec.environment.backendCwd,
    args: [],
    env: {},
    extendEnv: false,
    bootstrap: {
      mode: "desktop",
      noBrowser: true,
      port: Number(httpBaseUrl.port || (httpBaseUrl.protocol === "https:" ? 443 : 80)),
      host: httpBaseUrl.hostname,
      desktopBootstrapToken: credential,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    },
    bootstrapDelivery: "fd3",
    httpBaseUrl,
    captureOutput: false,
    preflightFailure,
  });

  const currentConfig = Effect.gen(function* () {
    const current = yield* Ref.get(attached);
    if (Option.isNone(current)) {
      const parked = yield* Ref.get(parkedFailure);
      if (Option.isNone(parked))
        return Option.none<DesktopBackendManager.DesktopBackendStartConfig>();
      // Park the reason on a config so the existing preflight surface
      // carries it. There is no server to dial, hence the placeholder.
      return Option.some(buildConfig(new URL("http://127.0.0.1/"), "", parked));
    }
    // No credential here: this read must stay synchronous (see the header).
    // `DesktopLocalEnvironmentAuth` mints one through `mintBootstrapCredential`
    // when it needs a bearer for the renderer.
    return Option.some(buildConfig(current.value.httpBaseUrl, "", Option.none()));
  }).pipe(Effect.withSpan("desktop.attachedBackend.currentConfig"));

  // One single-use administrative credential per call. A mint failure
  // degrades to None, which the bearer provider reports as an unconfigured
  // backend rather than a crash.
  const mintBootstrapCredential = Effect.gen(function* () {
    const current = yield* Ref.get(attached);
    if (Option.isNone(current)) return Option.none<string>();
    return yield* mintCredential({ dataHome: current.value.dataHome }).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        logWarning("could not mint a pairing credential for the attached service", {
          detail: error.detail,
        }).pipe(Effect.as(Option.none<string>())),
      ),
    );
  }).pipe(Effect.withSpan("desktop.attachedBackend.mintBootstrapCredential"));

  // The attached service's address, read straight off the attach result; the
  // renderer protocol asks for the target on every request.
  const httpBaseUrl = Ref.get(attached).pipe(
    Effect.map(Option.map((current) => current.httpBaseUrl)),
  );

  const snapshot = Effect.gen(function* () {
    return {
      desiredRunning: yield* Ref.get(desiredRunning),
      ready: yield* Ref.get(ready),
      // Nothing was spawned, so there is no pid to report. Consumers read
      // this to tell "we own a process" from "we are a client".
      activePid: Option.none<number>(),
      restartAttempt: 0,
      restartScheduled: false,
    } satisfies DesktopBackendManager.DesktopBackendSnapshot;
  });

  const waitForReady = (timeout: Duration.Duration) =>
    Effect.gen(function* () {
      // Give up early once something flipped desiredRunning off: there is
      // nothing left to become ready.
      if (!(yield* Ref.get(desiredRunning))) return { done: true, ready: false };
      const isReady = yield* Ref.get(ready);
      return isReady ? { done: true, ready: true } : { done: false, ready: false };
    }).pipe(
      Effect.repeat({
        until: (status) => status.done,
        schedule: Schedule.spaced(STARTING_POLL_INTERVAL),
      }),
      Effect.map((status) => status.ready),
      Effect.timeoutOption(timeout),
      Effect.map(Option.getOrElse(() => false)),
    );

  return {
    id: spec.id,
    label: spec.label,
    start,
    stop,
    currentConfig,
    mintBootstrapCredential,
    httpBaseUrl,
    snapshot,
    waitForReady,
    detached: true,
  } satisfies DesktopBackendManager.DesktopBackendInstance;
});

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off - adoption runs the Flow bootstrap script as a one-shot child and journals into the service's data home; both happen at the process boundary, before any server of ours exists. The journal is a plain JSON record read by humans and by the next launch, and its timestamps come from the injected `now` seam rather than the Effect clock so the whole state machine stays drivable from tests.
// First-launch adoption: turn a desktop that has no Flow service into one that
// attaches to a persistent service.
//
// Three decisions shape everything here:
//
//   1. The service is the *independent* Flow release bundle
//      (`flow-release.mjs install` into FLOW_RELEASE_HOME), never the
//      desktop's own bundled `apps/server/dist/bin.mjs`. The release
//      self-updates, so the desktop and the service keep separate update
//      trains — a desktop update must never be able to move the service
//      backwards, and a service update must not wait for an app release.
//   2. Data is never moved. The service is installed with the home that
//      already exists (`~/.t3` when `~/.t3/userdata` is there, else `~/.flow`).
//      Moving a home orphans the FalkorDB store (its directory is a hash of
//      the absolute brain path), breaks every managed worktree's absolute
//      `gitdir:` pointer, and re-keys the hook project ids. The `verify` step
//      exists to prove nothing moved.
//   3. Adoption never spawns a legacy private child on failure. It reports a
//      reason; the caller decides what to offer the user.
//
// Every step is journaled to `<home>/userdata/service-adoption.json` before the
// next one starts, so an adoption interrupted by a crash or a quit leaves a
// readable account of how far it got. A completed adoption short-circuits: a
// journal saying `adopted` plus a ready service means there is nothing to do.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const { dirname, join } = NodePath;

import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { legacyBaseDirProbePath, resolveHomeBaseDir } from "@t3tools/shared/homeBaseDir";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DESKTOP_PROTOCOL_SUPPORTED } from "./DesktopAttachedBackend.ts";
import {
  desktopServiceRegistryRoot,
  discoverService,
  fetchEnvironmentDescriptor,
  resolveFlowReleaseHome,
  type ServiceDiscoveryResult,
} from "./serviceDiscovery.ts";

export const ADOPTION_JOURNAL_VERSION = 1;
export const ADOPTION_JOURNAL_FILE = "service-adoption.json";

// The supervisor's own readiness deadline is 120s; anything shorter would
// report a slow first boot (brain runtime, embedding model) as a broken
// service.
const WAIT_READY_POLL_INTERVAL_MS = 500;
const WAIT_READY_TIMEOUT_MS = 120_000;
// A release install downloads and verifies a bundle, and may build from source.
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const INSTALL_MAX_BUFFER = 10 * 1024 * 1024;
const DESCRIPTOR_TIMEOUT_MS = 5_000;

export type AdoptionStepName =
  | "install-release"
  | "install-service"
  | "wait-ready"
  | "verify"
  | "rollback-uninstall";

/** What the user is told, and what the caller branches on. `network` and
    `install-failed` mean nothing was installed; the rest mean a service may
    have been created, and adoption has already tried to take it back out. */
export type AdoptionFailureReason =
  | "network"
  | "install-failed"
  | "service-failed"
  | "verify-failed"
  | "incompatible";

export interface AdoptionStep {
  readonly name: AdoptionStepName;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface AdoptionJournal {
  readonly version: typeof ADOPTION_JOURNAL_VERSION;
  readonly startedAt: string;
  readonly steps: readonly AdoptionStep[];
  /** `in-progress` is what a crash or a quit mid-adoption leaves behind. Only
      `adopted` short-circuits the next run, so an interrupted adoption is
      resumed rather than assumed to have worked. */
  readonly outcome: "in-progress" | "adopted" | "failed";
  readonly failure?: { readonly step: AdoptionStepName; readonly message: string };
}

export type AdoptionOutcome =
  | {
      readonly _tag: "adopted";
      readonly home: string;
      readonly journalPath: string;
      readonly journal: AdoptionJournal;
    }
  | { readonly _tag: "already-adopted"; readonly home: string; readonly journalPath: string }
  | {
      readonly _tag: "failed";
      readonly home: string;
      readonly journalPath: string;
      readonly reason: AdoptionFailureReason;
      readonly step: AdoptionStepName;
      readonly message: string;
      readonly journal: AdoptionJournal;
    };

export interface AdoptionCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Overlay on the inherited environment, not the whole environment: the
      bootstrap still needs PATH, HOME and the user's shell configuration. */
  readonly env: Readonly<Record<string, string>>;
}

export interface AdoptionRunResult {
  readonly ok: boolean;
  /** Combined output tail, or the spawn error. Goes straight into the journal. */
  readonly detail: string;
}

export interface AdoptionFileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

/** Every side effect adoption performs, so the state machine can be driven
    deterministically in tests without a filesystem, a network or a service. */
export interface AdoptionSeams {
  readonly run: (command: AdoptionCommand) => Effect.Effect<AdoptionRunResult>;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly statFile: (path: string) => Effect.Effect<Option.Option<AdoptionFileStat>>;
  readonly realpath: (path: string) => Effect.Effect<Option.Option<string>>;
  readonly readJson: (path: string) => Effect.Effect<unknown>;
  readonly writeJson: (path: string, value: unknown) => Effect.Effect<void>;
  readonly discover: () => Effect.Effect<ServiceDiscoveryResult>;
  readonly fetchDescriptor: (httpBaseUrl: URL) => Effect.Effect<Option.Option<unknown>>;
  readonly sleep: (millis: number) => Effect.Effect<void>;
  readonly now: () => number;
}

export interface AdoptServiceInput {
  readonly homeDirectory: string;
  /** Electron's own executable. With ELECTRON_RUN_AS_NODE=1 it is a Node 24.18
      runtime, which clears the bootstrap's Node 24.13.1+ gate. */
  readonly executablePath: string;
  readonly flowReleaseScriptPath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly seams?: Partial<AdoptionSeams>;
}

export interface AdoptionPaths {
  readonly home: string;
  readonly releaseHome: string;
  readonly registryRoot: string;
  readonly journalPath: string;
  readonly releaseReceiptPath: string;
  readonly stateDatabasePath: string;
}

/**
 * Where adoption reads and writes. `registryRoot` comes from the same resolver
 * attaching uses (`desktopServiceRegistryRoot`), so adoption cannot install a
 * service into a registry the desktop's discovery does not read.
 */
export const resolveAdoptionPaths = (input: {
  readonly homeDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly legacyHomeExists: boolean;
  /** Test seam for which CLI homes are already installed. */
  readonly exists?: (path: string) => boolean;
}): AdoptionPaths => {
  const home = resolveHomeBaseDir({
    explicit: input.env.T3CODE_HOME,
    homeDirectory: input.homeDirectory,
    joinPath: join,
    legacyHomeExists: input.legacyHomeExists,
  });
  const releaseHome = resolveFlowReleaseHome({
    env: input.env as NodeJS.ProcessEnv,
    homeDirectory: input.homeDirectory,
    ...(input.exists ? { exists: input.exists } : {}),
  });
  return {
    home,
    releaseHome,
    registryRoot: desktopServiceRegistryRoot({
      env: input.env as NodeJS.ProcessEnv,
      homeDirectory: input.homeDirectory,
      ...(input.exists ? { exists: input.exists } : {}),
    }),
    journalPath: join(home, "userdata", ADOPTION_JOURNAL_FILE),
    releaseReceiptPath: join(releaseHome, "current", "flow-release.json"),
    stateDatabasePath: join(home, "userdata", "state.sqlite"),
  };
};

/** A failed download reads as a broken install unless it is named as what it
    usually is: no network, or GitHub unreachable. */
const NETWORK_FAILURE_PATTERN =
  /download failed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|timed out|release feed/i;

const classifyInstallFailure = (detail: string): AdoptionFailureReason =>
  NETWORK_FAILURE_PATTERN.test(detail) ? "network" : "install-failed";

const decodeDescriptor = Schema.decodeUnknownOption(ExecutionEnvironmentDescriptor);

const parseOrigin = (origin: string): Option.Option<URL> => {
  try {
    return Option.some(new URL(origin));
  } catch {
    return Option.none<URL>();
  }
};

const realExists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  );

const defaultRun = (command: AdoptionCommand): Effect.Effect<AdoptionRunResult> =>
  Effect.promise(
    () =>
      new Promise<AdoptionRunResult>((resolvePromise) => {
        NodeChildProcess.execFile(
          command.command,
          [...command.args],
          {
            timeout: INSTALL_TIMEOUT_MS,
            maxBuffer: INSTALL_MAX_BUFFER,
            env: { ...process.env, ...command.env },
          },
          (error, stdout, stderr) => {
            const output = `${stdout}${stderr}`.trim();
            resolvePromise(
              error
                ? {
                    ok: false,
                    detail: `${error.message}${output ? `: ${output}` : ""}`.slice(-4000),
                  }
                : { ok: true, detail: output.slice(-4000) },
            );
          },
        );
      }),
  );

const defaultSeams = (input: AdoptServiceInput, paths: AdoptionPaths): AdoptionSeams => ({
  run: defaultRun,
  exists: realExists,
  statFile: (path) =>
    Effect.promise(() =>
      NodeFSP.stat(path).then(
        (stat) => Option.some({ size: Number(stat.size), mtimeMs: stat.mtimeMs }),
        () => Option.none<AdoptionFileStat>(),
      ),
    ),
  realpath: (path) =>
    Effect.promise(() =>
      NodeFSP.realpath(path).then(
        (value) => Option.some(value),
        () => Option.none<string>(),
      ),
    ),
  readJson: (path) =>
    Effect.promise(() =>
      NodeFSP.readFile(path, "utf8").then(
        (contents) => {
          try {
            return JSON.parse(contents) as unknown;
          } catch {
            return null;
          }
        },
        () => null,
      ),
    ),
  // Durable by temp+rename, the idiom in apps/server/src/atomicWrite.ts: a
  // journal truncated by a crash mid-write would be worse than no journal.
  writeJson: (path, value) =>
    Effect.promise(async () => {
      try {
        await NodeFSP.mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${String(process.pid)}.tmp`;
        await NodeFSP.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await NodeFSP.rename(temp, path);
      } catch {
        // The journal is a record, not a precondition. Losing it must not
        // fail an adoption that otherwise worked.
      }
    }),
  discover: () => Effect.promise(() => discoverService({ registryRoot: paths.registryRoot })),
  fetchDescriptor: (httpBaseUrl) =>
    Effect.promise(() =>
      fetchEnvironmentDescriptor(httpBaseUrl, DESCRIPTOR_TIMEOUT_MS).then(
        (payload) => Option.some(payload),
        () => Option.none<unknown>(),
      ),
    ),
  sleep: (millis) => Effect.sleep(millis),
  now: () => Date.now(),
  ...input.seams,
});

interface StepFailure {
  readonly step: AdoptionStepName;
  readonly reason: AdoptionFailureReason;
  readonly message: string;
}

export const adoptService = Effect.fn("desktop.serviceAdoption.adopt")(function* (
  input: AdoptServiceInput,
): Effect.fn.Return<AdoptionOutcome> {
  const env = input.env ?? process.env;
  // The home is resolved before the seams are assembled, because the default
  // seams need the registry root the home selection feeds into.
  const legacyHomeExists = yield* (input.seams?.exists ?? realExists)(
    legacyBaseDirProbePath(input.homeDirectory, join),
  );
  const paths = resolveAdoptionPaths({
    homeDirectory: input.homeDirectory,
    env,
    legacyHomeExists,
  });
  const seams = defaultSeams(input, paths);

  const releaseEnv = { ELECTRON_RUN_AS_NODE: "1", FLOW_RELEASE_HOME: paths.releaseHome } as const;
  const serviceEnv = { ...releaseEnv, FLOW_INSTANCE_HOME: paths.registryRoot } as const;

  const startedAt = new Date(seams.now()).toISOString();
  const steps: AdoptionStep[] = [];

  const journalOf = (
    outcome: AdoptionJournal["outcome"],
    failure?: AdoptionJournal["failure"],
  ): AdoptionJournal => ({
    version: ADOPTION_JOURNAL_VERSION,
    startedAt,
    steps: [...steps],
    outcome,
    ...(failure ? { failure } : {}),
  });

  const writeJournal = (
    outcome: AdoptionJournal["outcome"],
    failure?: AdoptionJournal["failure"],
  ) => seams.writeJson(paths.journalPath, journalOf(outcome, failure));

  /** Runs one step, appends its record, and persists the journal before the
      next step starts. `undefined` from the body means the step succeeded. */
  const step = (
    name: AdoptionStepName,
    body: Effect.Effect<{ readonly detail?: string; readonly failure?: StepFailure }>,
  ): Effect.Effect<Option.Option<StepFailure>> =>
    Effect.gen(function* () {
      const stepStartedAt = new Date(seams.now()).toISOString();
      const result = yield* body;
      steps.push({
        name,
        startedAt: stepStartedAt,
        finishedAt: new Date(seams.now()).toISOString(),
        ok: result.failure === undefined,
        ...(result.failure
          ? { detail: result.failure.message }
          : result.detail
            ? { detail: result.detail }
            : {}),
      });
      yield* writeJournal(result.failure ? "failed" : "in-progress", result.failure);
      return result.failure ? Option.some(result.failure) : Option.none<StepFailure>();
    });

  const fail = Effect.fn("desktop.serviceAdoption.fail")(function* (failure: StepFailure) {
    // Only uninstall a service adoption itself created. A failure before
    // `install-service` means there is nothing of ours to take back out, and
    // uninstalling then would remove somebody else's working service.
    if (failure.step !== "install-release") {
      const rollbackStartedAt = new Date(seams.now()).toISOString();
      const rollback = yield* seams.run({
        command: input.executablePath,
        args: [input.flowReleaseScriptPath, "service", "uninstall"],
        env: serviceEnv,
      });
      steps.push({
        name: "rollback-uninstall",
        startedAt: rollbackStartedAt,
        finishedAt: new Date(seams.now()).toISOString(),
        ok: rollback.ok,
        ...(rollback.detail ? { detail: rollback.detail } : {}),
      });
    }
    const journalFailure = { step: failure.step, message: failure.message };
    yield* writeJournal("failed", journalFailure);
    return {
      _tag: "failed",
      home: paths.home,
      journalPath: paths.journalPath,
      reason: failure.reason,
      step: failure.step,
      message: failure.message,
      journal: journalOf("failed", journalFailure),
    } as const satisfies AdoptionOutcome;
  });

  // Idempotence: a finished adoption plus a ready service is nothing to do,
  // and must not run a single command.
  const existingJournal = yield* seams.readJson(paths.journalPath);
  if (
    typeof existingJournal === "object" &&
    existingJournal !== null &&
    (existingJournal as { readonly outcome?: unknown }).outcome === "adopted"
  ) {
    const current = yield* seams.discover();
    if (current.status === "ready")
      return {
        _tag: "already-adopted",
        home: paths.home,
        journalPath: paths.journalPath,
      } as const;
  }

  // What must not change across adoption. Captured before anything runs, so a
  // service that moved or rewrote the database cannot pass `verify`.
  const databaseBefore = yield* seams.statFile(paths.stateDatabasePath);

  const installRelease = yield* step(
    "install-release",
    Effect.gen(function* () {
      if (yield* seams.exists(paths.releaseReceiptPath))
        return { detail: `Release already installed at ${paths.releaseHome}.` };
      const result = yield* seams.run({
        command: input.executablePath,
        args: [input.flowReleaseScriptPath, "install"],
        env: releaseEnv,
      });
      return result.ok
        ? { detail: result.detail }
        : {
            failure: {
              step: "install-release" as const,
              reason: classifyInstallFailure(result.detail),
              message: result.detail || "The Flow release could not be installed.",
            },
          };
    }),
  );
  if (Option.isSome(installRelease)) return yield* fail(installRelease.value);

  const installService = yield* step(
    "install-service",
    Effect.gen(function* () {
      const result = yield* seams.run({
        command: input.executablePath,
        args: [input.flowReleaseScriptPath, "service", "install", "--home", paths.home],
        env: serviceEnv,
      });
      return result.ok
        ? { detail: result.detail }
        : {
            failure: {
              step: "install-service" as const,
              reason: "service-failed" as const,
              message: result.detail || "The Flow service could not be installed.",
            },
          };
    }),
  );
  if (Option.isSome(installService)) return yield* fail(installService.value);

  let ready: ServiceDiscoveryResult | undefined;
  const waitReady = yield* step(
    "wait-ready",
    Effect.gen(function* () {
      const deadlinePolls = Math.ceil(WAIT_READY_TIMEOUT_MS / WAIT_READY_POLL_INTERVAL_MS);
      let last: ServiceDiscoveryResult | undefined;
      for (let poll = 0; poll < deadlinePolls; poll += 1) {
        last = yield* seams.discover();
        if (last.status === "ready") {
          ready = last;
          return { detail: `Service ready at ${last.serverOrigin ?? "an unreported origin"}.` };
        }
        if (last.status === "invalid" || last.status === "incompatible")
          return {
            failure: {
              step: "wait-ready" as const,
              reason: "incompatible" as const,
              message: last.reason ?? `Service reported ${last.status}.`,
            },
          };
        yield* seams.sleep(WAIT_READY_POLL_INTERVAL_MS);
      }
      return {
        failure: {
          step: "wait-ready" as const,
          reason: "service-failed" as const,
          message: `The Flow service did not become ready (last status: ${last?.status ?? "unknown"}).`,
        },
      };
    }),
  );
  if (Option.isSome(waitReady)) return yield* fail(waitReady.value);

  const verify = yield* step(
    "verify",
    Effect.gen(function* () {
      const settled = ready;
      const verifyFailed = (message: string) => ({
        failure: { step: "verify" as const, reason: "verify-failed" as const, message },
      });
      if (settled === undefined || settled.dataHome === undefined)
        return verifyFailed("The service did not report the data home it adopted.");

      // The whole point of adoption: the service owns the home that was
      // already there. A mismatch means data would be split across two homes.
      const adoptedHome = yield* seams.realpath(settled.dataHome);
      const expectedHome = yield* seams.realpath(paths.home);
      if (Option.isNone(adoptedHome) || Option.isNone(expectedHome))
        return verifyFailed("The adopted data home could not be resolved.");
      if (adoptedHome.value !== expectedHome.value)
        return verifyFailed(
          `The service adopted ${adoptedHome.value} instead of ${expectedHome.value}.`,
        );

      // Adoption never moves data. If a database was there before, the same
      // file must still be there, untouched.
      if (Option.isSome(databaseBefore)) {
        const databaseAfter = yield* seams.statFile(paths.stateDatabasePath);
        if (Option.isNone(databaseAfter))
          return verifyFailed(`${paths.stateDatabasePath} disappeared during adoption.`);
        if (
          databaseAfter.value.size !== databaseBefore.value.size ||
          databaseAfter.value.mtimeMs !== databaseBefore.value.mtimeMs
        )
          return verifyFailed(`${paths.stateDatabasePath} changed during adoption.`);
      }

      if (settled.serverOrigin === undefined)
        return verifyFailed("The service is ready but reported no address to connect to.");
      const origin = parseOrigin(settled.serverOrigin);
      if (Option.isNone(origin))
        return verifyFailed(`The service reported an unusable address: ${settled.serverOrigin}.`);
      const payload = yield* seams.fetchDescriptor(origin.value);
      if (Option.isNone(payload))
        return verifyFailed("The service did not answer its environment descriptor.");
      const descriptor = decodeDescriptor(payload.value);
      const generation = Option.isSome(descriptor) ? descriptor.value.desktopProtocol : undefined;
      if (generation === undefined)
        return {
          failure: {
            step: "verify" as const,
            reason: "incompatible" as const,
            message: "The service does not report a desktop-attach protocol generation.",
          },
        };
      if (
        generation < DESKTOP_PROTOCOL_SUPPORTED.min ||
        generation > DESKTOP_PROTOCOL_SUPPORTED.max
      )
        return {
          failure: {
            step: "verify" as const,
            reason: "incompatible" as const,
            message: `The service speaks desktop-attach generation ${String(generation)}; this app supports ${String(DESKTOP_PROTOCOL_SUPPORTED.min)} through ${String(DESKTOP_PROTOCOL_SUPPORTED.max)}.`,
          },
        };
      return { detail: `Adopted ${expectedHome.value} at generation ${String(generation)}.` };
    }),
  );
  if (Option.isSome(verify)) return yield* fail(verify.value);

  yield* writeJournal("adopted");
  return {
    _tag: "adopted",
    home: paths.home,
    journalPath: paths.journalPath,
    journal: journalOf("adopted"),
  } as const;
});

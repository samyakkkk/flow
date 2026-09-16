import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopServiceAdoption from "./DesktopServiceAdoption.ts";
import { desktopServiceRegistryRoot, type ServiceDiscoveryResult } from "./serviceDiscovery.ts";

const HOME_DIRECTORY = "/Users/alice";
const FRESH_HOME = "/Users/alice/.flow";
const LEGACY_HOME = "/Users/alice/.t3";
const RELEASE_HOME = "/Users/alice/.local/share/flow-browser";
const REGISTRY_ROOT = `${RELEASE_HOME}/instance-home`;
const RELEASE_RECEIPT = `${RELEASE_HOME}/current/flow-release.json`;
const EXECUTABLE = "/Applications/Flow.app/Contents/MacOS/Flow";
const BOOTSTRAP = "/Applications/Flow.app/Contents/Resources/flow-bootstrap/flow-release.mjs";
const ORIGIN = "http://127.0.0.1:7777";

const descriptor = (overrides: Record<string, unknown> = {}) => ({
  environmentId: "11111111-1111-4111-8111-111111111111",
  label: "Flow service",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "1.2.3",
  capabilities: {},
  desktopProtocol: 1,
  ...overrides,
});

const ready = (dataHome: string): ServiceDiscoveryResult => ({
  status: "ready",
  environmentId: "11111111-1111-4111-8111-111111111111",
  dataHome,
  runningCode: `${RELEASE_HOME}/current`,
  serverOrigin: ORIGIN,
});

interface WorldInput {
  readonly existingPaths?: readonly string[];
  readonly stats?: Readonly<Record<string, DesktopServiceAdoption.AdoptionFileStat>>;
  /** Consumed in order; the last entry repeats once the queue is drained. */
  readonly discoveries?: readonly ServiceDiscoveryResult[];
  readonly descriptorPayload?: unknown;
  readonly journal?: unknown;
  readonly failCommand?: (command: DesktopServiceAdoption.AdoptionCommand) => string | undefined;
  /** Applied to `<home>/userdata/state.sqlite` once the service is installed,
      standing in for a service that moved or rewrote the database. */
  readonly databaseAfterInstall?: DesktopServiceAdoption.AdoptionFileStat | null;
}

/** A whole filesystem, service and installer, in memory. Records every command
    and every journal write so a test can assert the exact argv and env. */
function makeWorld(input: WorldInput = {}) {
  const existing = new Set(input.existingPaths ?? []);
  const stats = new Map(Object.entries(input.stats ?? {}));
  const discoveries = [...(input.discoveries ?? [])];
  const commands: DesktopServiceAdoption.AdoptionCommand[] = [];
  const writes: { path: string; value: unknown }[] = [];
  let clock = Date.parse("2026-09-16T10:00:00.000Z");

  const seams: DesktopServiceAdoption.AdoptionSeams = {
    run: (command) =>
      Effect.sync(() => {
        commands.push(command);
        if (command.args[2] === "install" && input.databaseAfterInstall !== undefined) {
          for (const key of stats.keys()) {
            if (input.databaseAfterInstall === null) stats.delete(key);
            else stats.set(key, input.databaseAfterInstall);
          }
        }
        const message = input.failCommand?.(command);
        return message === undefined
          ? { ok: true, detail: "done" }
          : { ok: false, detail: message };
      }),
    exists: (path) => Effect.succeed(existing.has(path)),
    statFile: (path) =>
      Effect.sync(() => {
        const stat = stats.get(path);
        return stat === undefined
          ? Option.none<DesktopServiceAdoption.AdoptionFileStat>()
          : Option.some(stat);
      }),
    // Homes in these tests are already canonical; only a known path resolves,
    // so a service that adopted somewhere else cannot silently pass verify.
    realpath: (path) =>
      Effect.succeed(
        path === FRESH_HOME || path === LEGACY_HOME || existing.has(path)
          ? Option.some(path)
          : Option.none<string>(),
      ),
    readJson: (_path) => Effect.succeed(input.journal ?? null),
    writeJson: (path, value) =>
      Effect.sync(() => {
        writes.push({ path, value });
      }),
    discover: () =>
      Effect.succeed(
        discoveries.length > 1
          ? discoveries.shift()!
          : (discoveries[0] ?? { status: "not-configured" }),
      ),
    fetchDescriptor: (_url) =>
      Effect.succeed(
        input.descriptorPayload === undefined
          ? Option.none<unknown>()
          : Option.some(input.descriptorPayload),
      ),
    sleep: (_millis) => Effect.void,
    now: () => (clock += 1_000),
  };

  return { seams, commands, writes, existing, stats };
}

const adopt = (world: ReturnType<typeof makeWorld>, env: Record<string, string | undefined> = {}) =>
  DesktopServiceAdoption.adoptService({
    homeDirectory: HOME_DIRECTORY,
    executablePath: EXECUTABLE,
    flowReleaseScriptPath: BOOTSTRAP,
    env,
    seams: world.seams,
  });

const lastJournal = (world: ReturnType<typeof makeWorld>) =>
  world.writes.at(-1)?.value as DesktopServiceAdoption.AdoptionJournal | undefined;

describe("desktop service adoption", () => {
  it.effect("installs the release and the service into a fresh home", () =>
    Effect.gen(function* () {
      const world = makeWorld({
        discoveries: [{ status: "stopped" }, ready(FRESH_HOME)],
        descriptorPayload: descriptor(),
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag, "adopted");
      assert.equal(outcome.home, FRESH_HOME);
      // No `~/.t3/userdata`, so a fresh install lands in `~/.flow`, and the
      // service is told which home to adopt rather than picking its own.
      assert.deepEqual(
        world.commands.map((command) => command.args),
        [
          [BOOTSTRAP, "install"],
          [BOOTSTRAP, "service", "install", "--home", FRESH_HOME],
        ],
      );
      assert.deepEqual(
        world.commands.map((command) => command.command),
        [EXECUTABLE, EXECUTABLE],
      );
      // ELECTRON_RUN_AS_NODE turns the app binary into the Node 24.18 runtime
      // the bootstrap's version gate requires.
      assert.deepEqual(world.commands[0]?.env, {
        ELECTRON_RUN_AS_NODE: "1",
        FLOW_RELEASE_HOME: RELEASE_HOME,
      });
      assert.deepEqual(world.commands[1]?.env, {
        ELECTRON_RUN_AS_NODE: "1",
        FLOW_RELEASE_HOME: RELEASE_HOME,
        FLOW_INSTANCE_HOME: REGISTRY_ROOT,
      });

      const journal = lastJournal(world);
      assert.equal(world.writes.at(-1)?.path, `${FRESH_HOME}/userdata/service-adoption.json`);
      assert.equal(journal?.version, 1);
      assert.equal(journal?.outcome, "adopted");
      assert.deepEqual(
        journal?.steps.map((step) => [step.name, step.ok]),
        [
          ["install-release", true],
          ["install-service", true],
          ["wait-ready", true],
          ["verify", true],
        ],
      );
      // Journaled before the next step starts, not once at the end, and only
      // the final write claims the adoption succeeded.
      assert.equal(world.writes.length, (journal?.steps.length ?? 0) + 1);
      assert.deepEqual(
        world.writes
          .slice(0, -1)
          .map((write) => (write.value as DesktopServiceAdoption.AdoptionJournal).outcome),
        ["in-progress", "in-progress", "in-progress", "in-progress"],
      );
    }),
  );

  it.effect("adopts an existing ~/.t3 home without touching its database", () =>
    Effect.gen(function* () {
      const database = `${LEGACY_HOME}/userdata/state.sqlite`;
      const world = makeWorld({
        existingPaths: [`${LEGACY_HOME}/userdata`],
        stats: { [database]: { size: 4096, mtimeMs: 1_700_000_000_000 } },
        discoveries: [ready(LEGACY_HOME)],
        descriptorPayload: descriptor(),
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag, "adopted");
      assert.equal(outcome.home, LEGACY_HOME);
      assert.deepEqual(world.commands[1]?.args, [
        BOOTSTRAP,
        "service",
        "install",
        "--home",
        LEGACY_HOME,
      ]);
      // Data is adopted in place: same file, same size, same mtime.
      assert.deepEqual(world.stats.get(database), { size: 4096, mtimeMs: 1_700_000_000_000 });
    }),
  );

  it.effect("fails verification when the data it adopted was rewritten", () =>
    Effect.gen(function* () {
      const database = `${LEGACY_HOME}/userdata/state.sqlite`;
      const world = makeWorld({
        existingPaths: [`${LEGACY_HOME}/userdata`, RELEASE_RECEIPT],
        stats: { [database]: { size: 4096, mtimeMs: 1_700_000_000_000 } },
        databaseAfterInstall: { size: 0, mtimeMs: 1_700_000_999_000 },
        discoveries: [ready(LEGACY_HOME)],
        descriptorPayload: descriptor(),
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag === "failed" && outcome.reason, "verify-failed");
      assert.include(outcome._tag === "failed" ? outcome.message : "", "changed during adoption");
      assert.deepEqual(world.commands.at(-1)?.args, [BOOTSTRAP, "service", "uninstall"]);
    }),
  );

  it.effect("skips the release install when a release is already present", () =>
    Effect.gen(function* () {
      const world = makeWorld({
        existingPaths: [RELEASE_RECEIPT],
        discoveries: [ready(FRESH_HOME)],
        descriptorPayload: descriptor(),
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag, "adopted");
      assert.deepEqual(
        world.commands.map((command) => command.args),
        [[BOOTSTRAP, "service", "install", "--home", FRESH_HOME]],
      );
      assert.equal(lastJournal(world)?.steps[0]?.ok, true);
    }),
  );

  it.effect("uninstalls the service it created when installing it fails", () =>
    Effect.gen(function* () {
      const world = makeWorld({
        existingPaths: [RELEASE_RECEIPT],
        failCommand: (command) =>
          command.args[1] === "service" && command.args[2] === "install"
            ? "launchctl could not load the Flow service"
            : undefined,
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag, "failed");
      assert.equal(outcome._tag === "failed" && outcome.reason, "service-failed");
      assert.equal(outcome._tag === "failed" && outcome.step, "install-service");
      assert.deepEqual(world.commands.at(-1)?.args, [BOOTSTRAP, "service", "uninstall"]);

      const journal = lastJournal(world);
      assert.equal(journal?.outcome, "failed");
      assert.equal(journal?.failure?.step, "install-service");
      assert.deepEqual(
        journal?.steps.map((step) => [step.name, step.ok]),
        [
          ["install-release", true],
          ["install-service", false],
          ["rollback-uninstall", true],
        ],
      );
    }),
  );

  it.effect("never uninstalls a service it did not create", () =>
    Effect.gen(function* () {
      const world = makeWorld({
        failCommand: (command) =>
          command.args[1] === "install" ? "Download failed (503): github.com" : undefined,
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag, "failed");
      // A failed download is a missing network, not a broken installer.
      assert.equal(outcome._tag === "failed" && outcome.reason, "network");
      assert.deepEqual(
        world.commands.map((command) => command.args),
        [[BOOTSTRAP, "install"]],
      );
    }),
  );

  it.effect("fails verification when the service adopted another home", () =>
    Effect.gen(function* () {
      const world = makeWorld({
        existingPaths: [RELEASE_RECEIPT, "/Volumes/other/home"],
        discoveries: [ready("/Volumes/other/home")],
        descriptorPayload: descriptor(),
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag, "failed");
      assert.equal(outcome._tag === "failed" && outcome.reason, "verify-failed");
      assert.equal(outcome._tag === "failed" && outcome.step, "verify");
      assert.include(
        outcome._tag === "failed" ? outcome.message : "",
        "adopted /Volumes/other/home instead of",
      );
      assert.deepEqual(world.commands.at(-1)?.args, [BOOTSTRAP, "service", "uninstall"]);
    }),
  );

  it.effect("reports an unsupported desktop-attach generation as incompatible", () =>
    Effect.gen(function* () {
      const world = makeWorld({
        existingPaths: [RELEASE_RECEIPT],
        discoveries: [ready(FRESH_HOME)],
        descriptorPayload: descriptor({ desktopProtocol: 99 }),
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag === "failed" && outcome.reason, "incompatible");
    }),
  );

  it.effect("does nothing when a previous adoption succeeded and the service is ready", () =>
    Effect.gen(function* () {
      const world = makeWorld({
        journal: {
          version: 1,
          startedAt: "2026-09-16T09:00:00.000Z",
          steps: [],
          outcome: "adopted",
        },
        discoveries: [ready(FRESH_HOME)],
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag, "already-adopted");
      assert.equal(outcome.home, FRESH_HOME);
      assert.lengthOf(world.commands, 0);
      assert.lengthOf(world.writes, 0);
    }),
  );

  it.effect("re-runs adoption when a previous run failed", () =>
    Effect.gen(function* () {
      const world = makeWorld({
        existingPaths: [RELEASE_RECEIPT],
        journal: {
          version: 1,
          startedAt: "2026-09-16T09:00:00.000Z",
          steps: [],
          outcome: "failed",
        },
        discoveries: [ready(FRESH_HOME)],
        descriptorPayload: descriptor(),
      });

      const outcome = yield* adopt(world);

      assert.equal(outcome._tag, "adopted");
      assert.deepEqual(
        world.commands.map((command) => command.args),
        [[BOOTSTRAP, "service", "install", "--home", FRESH_HOME]],
      );
    }),
  );

  it.effect("honors explicit release and registry locations", () =>
    Effect.gen(function* () {
      const world = makeWorld({
        discoveries: [ready(FRESH_HOME)],
        descriptorPayload: descriptor(),
      });

      yield* adopt(world, {
        FLOW_RELEASE_HOME: "/opt/flow-release",
        FLOW_INSTANCE_HOME: "/opt/flow-registry",
      });

      assert.deepEqual(world.commands[1]?.env, {
        ELECTRON_RUN_AS_NODE: "1",
        FLOW_RELEASE_HOME: "/opt/flow-release",
        FLOW_INSTANCE_HOME: "/opt/flow-registry",
      });
    }),
  );

  it("installs into the registry the desktop attaches to", () => {
    // One resolver on both sides: adoption must never install a service into a
    // registry discovery does not read.
    for (const env of [
      {},
      { FLOW_RELEASE_HOME: "/opt/flow-release" },
      { FLOW_INSTANCE_HOME: "/srv/flow-app" },
    ]) {
      assert.equal(
        DesktopServiceAdoption.resolveAdoptionPaths({
          homeDirectory: HOME_DIRECTORY,
          env,
          legacyHomeExists: false,
        }).registryRoot,
        desktopServiceRegistryRoot({ env, homeDirectory: HOME_DIRECTORY }),
      );
    }
  });

  it("mirrors the bootstrap's registry default", () => {
    const paths = DesktopServiceAdoption.resolveAdoptionPaths({
      homeDirectory: HOME_DIRECTORY,
      env: {},
      legacyHomeExists: false,
    });
    assert.equal(paths.releaseHome, RELEASE_HOME);
    assert.equal(paths.registryRoot, REGISTRY_ROOT);
    assert.equal(paths.journalPath, `${FRESH_HOME}/userdata/service-adoption.json`);
  });
});

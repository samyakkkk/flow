import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type * as DesktopServiceAdoption from "./DesktopServiceAdoption.ts";
import type { DesktopBackendSnapshot, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

function makeStubInstance(
  id: DesktopBackendPool.BackendInstanceId,
  label: string,
  httpBaseUrl?: Effect.Effect<Option.Option<URL>>,
): DesktopBackendPool.DesktopBackendInstance {
  const snapshot: DesktopBackendSnapshot = {
    desiredRunning: false,
    ready: false,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  };
  return {
    id,
    label: Effect.succeed(label),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    ...(httpBaseUrl === undefined ? {} : { httpBaseUrl }),
    snapshot: Effect.succeed(snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

function makePoolLayer(
  labelRef: Ref.Ref<string>,
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({}),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected HTTP request")),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => Effect.void,
              discardSession: Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
        Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
          latest: Effect.succeed(Option.none()),
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControl: () => Effect.void,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary: Effect.die("unexpected primary config resolve"),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
          attachedBackendEnvironment: Effect.succeed({
            executablePath: "/test/electron",
            backendEntryPath: "/test/server/bin.mjs",
            backendCwd: "/test",
          }),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        // The pool only reads the home directory and the bootstrap script path
        // out of the environment, for first-launch service adoption.
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          homeDirectory: "/Users/alice",
          flowReleaseScriptPath: "/repo/scripts/flow-release.mjs",
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopWslEnvironment.layerTest(),
        ElectronDialog.layer,
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected window create"),
          ensureMain: Effect.die("unexpected window ensure"),
          revealOrCreateMain: Effect.die("unexpected window reveal"),
          activate: Effect.die("unexpected window activate"),
          createMainIfBackendReady: Effect.die("unexpected window create"),
          showConnectingSplash: Effect.void,
          handleBackendReady: () => Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          dispatchMenuAction: () => Effect.die("unexpected menu action"),
          zoomMain: () => Effect.die("unexpected zoom"),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

describe("DesktopBackendPool", () => {
  it.effect("layerTest exposes registered instances by id", () =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const fetchedPrimary = yield* pool.get(DesktopBackendPool.PRIMARY_INSTANCE_ID);
      const fetchedWsl = yield* pool.get(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"));
      const fetchedMissing = yield* pool.get(DesktopBackendPool.BackendInstanceId("missing"));
      const all = yield* pool.list;
      const resolvedPrimary = yield* pool.primary;

      assert.equal(yield* Option.getOrThrow(fetchedPrimary).label, "Windows");
      assert.equal(yield* Option.getOrThrow(fetchedWsl).label, "WSL (Ubuntu)");
      assert.isTrue(Option.isNone(fetchedMissing));
      assert.lengthOf(all, 2);
      // First instance becomes primary in layerTest so single-instance
      // stubs don't have to wire an explicit primary.
      assert.equal(resolvedPrimary.id, DesktopBackendPool.PRIMARY_INSTANCE_ID);
    }).pipe(
      Effect.provide(
        DesktopBackendPool.layerTest([
          makeStubInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, "Windows"),
          makeStubInstance(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"), "WSL (Ubuntu)"),
        ]),
      ),
    ),
  );

  it.effect("reports the primary's live address as it changes", () =>
    Effect.gen(function* () {
      // The renderer protocol reads this on every request, so it has to follow
      // the primary rather than report an address captured once.
      let current = Option.none<URL>();
      const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
        Effect.provide(
          DesktopBackendPool.layerTest([
            makeStubInstance(
              DesktopBackendPool.PRIMARY_INSTANCE_ID,
              "Flow service",
              Effect.sync(() => current),
            ),
          ]),
        ),
      );

      assert.isTrue(Option.isNone(yield* pool.primaryHttpBaseUrl));
      current = Option.some(new URL("http://127.0.0.1:3773/"));
      assert.deepEqual(
        Option.map(yield* pool.primaryHttpBaseUrl, (url) => url.href),
        Option.some("http://127.0.0.1:3773/"),
      );
    }),
  );

  it.effect("reports no primary address for an instance that cannot report one", () =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      assert.isTrue(Option.isNone(yield* pool.primaryHttpBaseUrl));
    }).pipe(
      Effect.provide(
        DesktopBackendPool.layerTest([
          makeStubInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, "Windows"),
        ]),
      ),
    ),
  );

  it.effect("layerTest dies when no instances are supplied", () =>
    Effect.exit(
      Effect.gen(function* () {
        yield* DesktopBackendPool.DesktopBackendPool;
      }).pipe(Effect.provide(DesktopBackendPool.layerTest([]))),
    ).pipe(Effect.map((exit) => assert.equal(exit._tag, "Failure"))),
  );

  it.effect("resolves the primary label lazily after pool layer construction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const labelRef = yield* Ref.make("Windows");
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
          Effect.provide(makePoolLayer(labelRef)),
        );
        const primary = yield* pool.primary;

        yield* Ref.set(labelRef, "WSL (Ubuntu)");

        assert.equal(yield* primary.label, "WSL (Ubuntu)");
      }),
    ),
  );

  describe("attach failure handling", () => {
    const notInstalled = {
      reason: "The Flow service is not installed yet.",
      fatal: true,
      attach: { kind: "not-installed", detail: "Service status: not-configured." },
    } as const;
    const adopted = {
      _tag: "adopted",
      home: "/Users/alice/.flow",
      journalPath: "/Users/alice/.flow/userdata/service-adoption.json",
      journal: {
        version: 1,
        startedAt: "2026-09-16T10:00:00.000Z",
        steps: [
          {
            name: "install-service",
            startedAt: "2026-09-16T10:00:00.000Z",
            finishedAt: "2026-09-16T10:00:01.000Z",
            ok: true,
          },
        ],
        outcome: "adopted",
      },
    } as const satisfies DesktopServiceAdoption.AdoptionOutcome;

    const makeHandler = (
      outcomes: DesktopServiceAdoption.AdoptionOutcome[],
      startResults: Array<{ ok: boolean }> = [{ ok: true }],
    ) =>
      Effect.gen(function* () {
        const starts = yield* Ref.make(0);
        const adoptions = yield* Ref.make(0);
        const surfaced = yield* Ref.make(0);
        const events: string[] = [];
        const recovery = yield* DesktopBackendPool.makeAttachFailureHandler({
          startService: () =>
            Ref.updateAndGet(starts, (count) => count + 1).pipe(
              Effect.map((count) => ({
                ok: startResults[count - 1]?.ok ?? true,
                reason: null,
                detail: null,
              })),
            ),
          adopt: () =>
            Ref.updateAndGet(adoptions, (count) => count + 1).pipe(
              Effect.map((count) => outcomes[count - 1] ?? adopted),
            ),
          logStep: (step) =>
            Effect.sync(() => {
              events.push(String(step.event));
            }),
          surface: () => Ref.update(surfaced, (count) => count + 1),
        });
        return {
          handle: recovery.handle,
          allowAdoption: recovery.allowAdoption,
          adoptions,
          starts,
          surfaced,
          events,
        };
      });

    it.effect("adopts the service once when none is installed", () =>
      Effect.gen(function* () {
        const { handle, allowAdoption, adoptions, surfaced, events } = yield* makeHandler([
          adopted,
          adopted,
        ]);

        // True asks the attached instance for one more attach attempt.
        assert.isTrue(yield* handle(notInstalled));
        assert.equal(yield* Ref.get(adoptions), 1);
        assert.equal(yield* Ref.get(surfaced), 0);
        assert.deepEqual(events, ["attach-failed", "adoption-step", "adoption-outcome"]);

        // A second not-installed after a completed adoption is not something
        // re-running would fix, so it stops and shows the recovery screen.
        assert.isFalse(yield* handle(notInstalled));
        assert.equal(yield* Ref.get(adoptions), 1);
        assert.equal(yield* Ref.get(surfaced), 1);

        // An explicit retry from that screen is the user asking for the whole
        // thing again, adoption included.
        yield* allowAdoption;
        assert.isTrue(yield* handle(notInstalled));
        assert.equal(yield* Ref.get(adoptions), 2);
      }),
    );

    it.effect("reports the adoption reason instead of retrying when it fails", () =>
      Effect.gen(function* () {
        const { handle, surfaced } = yield* makeHandler([
          {
            _tag: "failed",
            home: "/Users/alice/.flow",
            journalPath: "/Users/alice/.flow/userdata/service-adoption.json",
            reason: "network",
            step: "install-release",
            message: "Download failed (503).",
            journal: {
              version: 1,
              startedAt: "2026-09-16T10:00:00.000Z",
              steps: [],
              outcome: "failed",
              failure: { step: "install-release", message: "Download failed (503)." },
            },
          },
        ]);

        assert.isFalse(yield* handle(notInstalled));
        assert.equal(yield* Ref.get(surfaced), 1);
      }),
    );

    const stopped = {
      reason: "The Flow service is not running.",
      fatal: true,
      attach: { kind: "stopped", detail: "Service status: stopped." },
    } as const;

    it.effect("starts a stopped service once, then shows the recovery screen", () =>
      Effect.gen(function* () {
        const { handle, allowAdoption, adoptions, starts, surfaced, events } = yield* makeHandler(
          [],
          [{ ok: true }, { ok: false }],
        );

        // A successful start asks the attached instance to try again.
        assert.isTrue(yield* handle(stopped));
        assert.equal(yield* Ref.get(starts), 1);
        assert.equal(yield* Ref.get(adoptions), 0);
        assert.equal(yield* Ref.get(surfaced), 0);
        assert.deepEqual(events, ["attach-failed", "service-start"]);

        // Still stopped after a start: not something a second automatic start
        // would fix, so the screen appears with its manual start action.
        assert.isFalse(yield* handle(stopped));
        assert.equal(yield* Ref.get(starts), 1);
        assert.equal(yield* Ref.get(surfaced), 1);

        // An explicit retry allows one more automatic start; a failed start
        // surfaces immediately.
        yield* allowAdoption;
        assert.isFalse(yield* handle(stopped));
        assert.equal(yield* Ref.get(starts), 2);
        assert.equal(yield* Ref.get(surfaced), 2);
      }),
    );

    it.effect("leaves other attach failures to the service layer", () =>
      Effect.gen(function* () {
        const { handle, adoptions, starts, surfaced } = yield* makeHandler([]);

        assert.isFalse(
          yield* handle({
            reason: "The Flow service did not answer.",
            fatal: true,
            attach: { kind: "unreachable", detail: "Timed out." },
          }),
        );
        assert.equal(yield* Ref.get(adoptions), 0);
        assert.equal(yield* Ref.get(starts), 0);
        assert.equal(yield* Ref.get(surfaced), 1);
      }),
    );
  });
});

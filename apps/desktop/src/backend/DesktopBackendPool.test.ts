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

    const makeHandler = (outcomes: DesktopServiceAdoption.AdoptionOutcome[]) =>
      Effect.gen(function* () {
        const adoptions = yield* Ref.make(0);
        const reports: string[] = [];
        const events: string[] = [];
        const handle = yield* DesktopBackendPool.makeAttachFailureHandler({
          adopt: () =>
            Ref.updateAndGet(adoptions, (count) => count + 1).pipe(
              Effect.map((count) => outcomes[count - 1] ?? adopted),
            ),
          logStep: (step) =>
            Effect.sync(() => {
              events.push(String(step.event));
            }),
          report: (input) =>
            Effect.sync(() => {
              reports.push(input.body);
            }),
        });
        return { handle, adoptions, reports, events };
      });

    it.effect("adopts the service once when none is installed", () =>
      Effect.gen(function* () {
        const { handle, adoptions, reports, events } = yield* makeHandler([adopted]);

        // True asks the attached instance for one more attach attempt.
        assert.isTrue(yield* handle(notInstalled));
        assert.equal(yield* Ref.get(adoptions), 1);
        assert.deepEqual(reports, []);
        assert.deepEqual(events, ["attach-failed", "adoption-step", "adoption-outcome"]);

        // A second not-installed after a completed adoption is not something
        // re-running would fix, so it stops and tells the user.
        assert.isFalse(yield* handle(notInstalled));
        assert.equal(yield* Ref.get(adoptions), 1);
        assert.lengthOf(reports, 1);
      }),
    );

    it.effect("reports the adoption reason instead of retrying when it fails", () =>
      Effect.gen(function* () {
        const { handle, reports } = yield* makeHandler([
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
        assert.lengthOf(reports, 1);
        assert.include(reports[0] ?? "", "network: Download failed (503).");
      }),
    );

    it.effect("leaves other attach failures to the service layer", () =>
      Effect.gen(function* () {
        const { handle, adoptions, reports } = yield* makeHandler([]);

        assert.isFalse(
          yield* handle({
            reason: "The Flow service is not running.",
            fatal: true,
            attach: { kind: "stopped", detail: "Service status: stopped." },
          }),
        );
        assert.equal(yield* Ref.get(adoptions), 0);
        assert.lengthOf(reports, 1);
      }),
    );
  });
});

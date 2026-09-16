// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the journal reader and the legacy
// marker are filesystem facts, so the fixture writes real ones in a temp home.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  consumeLegacyBackendMarker,
  legacyBackendMarkerPath,
  readFlowServiceAdoption,
  requestLegacyBackendOnNextLaunch,
} from "../../backend/flowServiceRecovery.ts";
import {
  makeFlowServiceRecoveryIpcMethods,
  type FlowServiceRecoverySeams,
} from "./flowServiceRecovery.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const tempDir = async (prefix: string) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  cleanups.push(() => NodeFSP.rm(dir, { recursive: true, force: true }));
  return dir;
};

const baseSeams: FlowServiceRecoverySeams = {
  retryAttach: Effect.void,
  readAdoption: () => Promise.resolve(null),
  mintPairingUrl: () => Promise.resolve({ ok: false, detail: "no service" }),
  openExternal: () => Effect.succeed(true),
  requestLegacyBackend: () => Promise.resolve(),
  relaunch: Effect.void,
};

const methodsWith = (overrides: Partial<FlowServiceRecoverySeams>) =>
  makeFlowServiceRecoveryIpcMethods(Effect.succeed({ ...baseSeams, ...overrides }));

describe("flow service recovery IPC", () => {
  it.effect("retry asks the pool for exactly one more attach", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const methods = methodsWith({
        retryAttach: Ref.update(attempts, (count) => count + 1),
      });

      expect(yield* methods.retryFlowServiceAttach.handler(undefined)).toEqual({
        ok: true,
        detail: null,
      });
      expect(yield* Ref.get(attempts)).toBe(1);
    }),
  );

  it.effect("a retry that cannot start is reported, not thrown", () =>
    Effect.gen(function* () {
      const methods = methodsWith({ retryAttach: Effect.die("no pool") });

      const result = (yield* methods.retryFlowServiceAttach.handler(undefined)) as {
        readonly ok: boolean;
      };

      expect(result.ok).toBe(false);
    }),
  );

  it.effect("the adoption read maps the journal the desktop wrote", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => tempDir("flow-recovery-journal-"));
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(home, ".flow/userdata"), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(home, ".flow/userdata/service-adoption.json"),
          JSON.stringify({
            version: 1,
            startedAt: "2026-09-16T10:00:00.000Z",
            steps: [
              { name: "install-release", ok: true, startedAt: "x", finishedAt: "y" },
              {
                name: "install-service",
                ok: false,
                detail: "boom",
                startedAt: "x",
                finishedAt: "y",
              },
              "not a step",
            ],
            outcome: "failed",
            failure: { step: "install-service", message: "boom" },
          }),
        ),
      );

      const methods = methodsWith({
        readAdoption: () =>
          readFlowServiceAdoption({
            homeDirectory: home,
            stateDir: NodePath.join(home, ".flow/userdata"),
            executablePath: "/unused",
            backendEntryPath: "/unused",
            backendCwd: home,
            env: {},
          }),
      });

      expect(yield* methods.getFlowServiceAdoption.handler(undefined)).toEqual({
        outcome: "failed",
        // The malformed entry is dropped rather than failing the whole read: a
        // screen that cannot list the steps still has to render.
        steps: [
          { name: "install-release", ok: true, detail: null },
          { name: "install-service", ok: false, detail: "boom" },
        ],
        failure: { step: "install-service", message: "boom" },
      });
    }),
  );

  it.effect("no journal reads as null rather than an error", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => tempDir("flow-recovery-nojournal-"));
      const methods = methodsWith({
        readAdoption: () =>
          readFlowServiceAdoption({
            homeDirectory: home,
            stateDir: home,
            executablePath: "/unused",
            backendEntryPath: "/unused",
            backendCwd: home,
            env: {},
          }),
      });

      expect(yield* methods.getFlowServiceAdoption.handler(undefined)).toBeNull();
    }),
  );

  it.effect("open-in-browser hands the credential to the OS and not to the renderer", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<string[]>([]);
      const methods = methodsWith({
        mintPairingUrl: () =>
          Promise.resolve({ ok: true, pairingUrl: "http://127.0.0.1:3773/pair#token=SECRET" }),
        openExternal: (url) => Ref.update(opened, (urls) => [...urls, url]).pipe(Effect.as(true)),
      });

      const result = yield* methods.openFlowServiceInBrowser.handler(undefined);

      expect(result).toEqual({ ok: true, detail: null });
      // The whole point: the token reached the browser and nothing else.
      expect(yield* Ref.get(opened)).toEqual(["http://127.0.0.1:3773/pair#token=SECRET"]);
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }),
  );

  it.effect("open-in-browser reports why it could not mint, without opening anything", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make(0);
      const methods = methodsWith({
        mintPairingUrl: () => Promise.resolve({ ok: false, detail: "The service is not running." }),
        openExternal: () => Ref.update(opened, (count) => count + 1).pipe(Effect.as(true)),
      });

      expect(yield* methods.openFlowServiceInBrowser.handler(undefined)).toEqual({
        ok: false,
        detail: "The service is not running.",
      });
      expect(yield* Ref.get(opened)).toBe(0);
    }),
  );

  it.effect("the legacy relaunch leaves a one-shot flag, then relaunches", () =>
    Effect.gen(function* () {
      const stateDir = yield* Effect.promise(() => tempDir("flow-recovery-legacy-"));
      const order: string[] = [];
      const methods = methodsWith({
        requestLegacyBackend: async () => {
          order.push("marker");
          await requestLegacyBackendOnNextLaunch(stateDir);
        },
        relaunch: Effect.sync(() => {
          order.push("relaunch");
        }),
      });

      expect(yield* methods.relaunchWithLegacyBackend.handler(undefined)).toEqual({
        ok: true,
        detail: null,
      });
      // A relaunch that beat the marker would come back attached, which reads
      // as the button having done nothing.
      expect(order).toEqual(["marker", "relaunch"]);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.access(legacyBackendMarkerPath(stateDir)).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(true);

      // One relaunch, not a mode: reading the flag clears it.
      expect(consumeLegacyBackendMarker(stateDir)).toBe(true);
      expect(consumeLegacyBackendMarker(stateDir)).toBe(false);
    }),
  );
});

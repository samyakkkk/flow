// @effect-diagnostics nodeBuiltinImport:off - the handlers read a real registry directory, so the fixture writes one.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ServiceProcessRunner } from "../../backend/flowService.ts";
import { makeFlowServiceIpcMethods } from "./flowService.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-service-ipc-"));
  cleanups.push(() => NodeFSP.rm(home, { recursive: true, force: true }));
  const registryRoot = NodePath.join(home, "instance-home");
  const directory = NodePath.join(registryRoot, "instances/primary");
  await NodeFSP.mkdir(NodePath.join(directory, "data"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(directory, "config.json"),
    JSON.stringify({
      version: 1,
      id: "environment",
      name: "primary",
      mode: "isolated",
      dev: false,
      home: NodePath.join(directory, "data"),
      code: NodePath.join(home, "code"),
    }),
  );
  return { home, registryRoot, directory };
}

const neverOkRunner: ServiceProcessRunner = () =>
  Promise.resolve({ ok: false, stdout: "", stderr: "Could not find service." });

describe("flow service IPC", () => {
  it.effect("encodes a status the renderer can decode, without the control token", () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(() => fixture());
      const methods = makeFlowServiceIpcMethods({
        registryRoot: f.registryRoot,
        homeDirectory: f.home,
        host: "darwin",
        uid: 501,
        run: neverOkRunner,
      });

      const encoded = yield* methods.getFlowServiceStatus.handler(undefined);

      expect(encoded).toMatchObject({
        installed: false,
        loaded: false,
        current: false,
        label: "com.flow.service",
        instance: { phase: "stopped", environmentId: "environment" },
      });
      // The supervisor's control token belongs to the lifecycle owner: the
      // encoded status carries the contract's fields and nothing else.
      expect(Object.keys(encoded as Record<string, unknown>).toSorted()).toEqual([
        "current",
        "installed",
        "instance",
        "label",
        "loaded",
        "unitPath",
      ]);
    }),
  );

  it.effect("returns a typed refusal instead of rejecting when nothing manages the service", () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(() => fixture());
      const methods = makeFlowServiceIpcMethods({
        registryRoot: f.registryRoot,
        homeDirectory: f.home,
        host: "darwin",
        uid: 501,
        run: neverOkRunner,
      });

      const restart = yield* methods.restartFlowService.handler(undefined);
      const stop = yield* methods.stopFlowService.handler(undefined);

      expect(restart).toEqual({ ok: false, reason: "not-managed", detail: null });
      expect(stop).toEqual({ ok: false, reason: "not-running", detail: null });
    }),
  );
});

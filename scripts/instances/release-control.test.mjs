import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { releaseController } from "./release-control.mjs";
import { releaseServerPort } from "./supervisor.mjs";
const { test } = NodeTest;
const assert = NodeAssert;
const { join } = NodePath;

async function installation(t) {
  const home = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "flow-update-control-")),
  );
  t.after(() => NodeFSP.rm(home, { force: true, recursive: true }));
  for (const tag of ["flow-v1.0.0", "flow-v1.1.0"]) {
    const directory = join(home, "releases", tag);
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(join(directory, "flow-release.json"), JSON.stringify({ tag }));
  }
  await NodeFSP.symlink("releases/flow-v1.1.0", join(home, "current"));
  return { home, code: join(home, "releases/flow-v1.0.0") };
}

test("reports a prepared version without restarting or revealing supervisor credentials", async (t) => {
  const input = await installation(t);
  const controller = releaseController({
    ...input,
    restart: () => assert.fail("unexpected restart"),
  });
  assert.deepEqual(await controller.read(), {
    supported: true,
    currentVersion: "1.0.0",
    readyVersion: "1.1.0",
    restarting: false,
  });
  const current = releaseController({
    ...input,
    code: join(input.home, "releases/flow-v1.1.0"),
    restart: () => assert.fail("unexpected restart"),
  });
  await assert.rejects(current.apply(), /No prepared/);
});

test("simultaneous clicks start one restart and a failed detached restarter permits retry", async (t) => {
  const input = await installation(t);
  let restarts = 0;
  let failed;
  const controller = releaseController({
    ...input,
    restart: async (onFailure) => {
      restarts++;
      failed = onFailure;
    },
  });
  const states = await Promise.all([controller.apply(), controller.apply()]);
  assert.equal(restarts, 1);
  assert.equal(
    states.every((state) => state.restarting),
    true,
  );
  failed();
  assert.equal((await controller.read()).restarting, false);
  await controller.apply();
  assert.equal(restarts, 2);
});

test("spawn failure clears restarting and source installations cannot be restarted", async (t) => {
  const input = await installation(t);
  const controller = releaseController({
    ...input,
    restart: async () => {
      throw Error("spawn failed");
    },
  });
  await assert.rejects(controller.apply(), /spawn failed/);
  assert.equal((await controller.read()).restarting, false);
  const source = releaseController({
    ...input,
    code: "/unmanaged/source",
    restart: () => assert.fail("unexpected restart"),
  });
  assert.equal((await source.read()).supported, false);
  await assert.rejects(source.apply(), /No prepared/);
});

test("a release server keeps its browser port across restarts and rejects corrupt saved ports", async (t) => {
  const { home } = await installation(t);
  assert.equal(await releaseServerPort(home, async () => 43123), 43123);
  assert.equal(
    await releaseServerPort(home, async () => assert.fail("must reuse saved port")),
    43123,
  );
  await NodeFSP.writeFile(join(home, "release-port.json"), JSON.stringify({ port: 0 }));
  await assert.rejects(releaseServerPort(home), /Invalid saved/);
});

import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { recordLinks } from "./bundle-links.mjs";
import { linkManifest, restoreLinks } from "./flow-release.mjs";

const { test } = NodeTest;
const assert = NodeAssert;
const { join } = NodePath;

async function bundle(t) {
  const root = await NodeFSP.realpath(await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "flow-links-")));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  await NodeFSP.mkdir(join(root, "packages/contracts/src"), { recursive: true });
  await NodeFSP.writeFile(join(root, "packages/contracts/src/index.ts"), "export {};\n");
  await NodeFSP.mkdir(join(root, "node_modules/@t3tools"), { recursive: true });
  // Absolute, the way a junction is.
  await NodeFSP.symlink(
    join(root, "packages/contracts"),
    join(root, "node_modules/@t3tools/contracts"),
  );
  return root;
}

test("a bundle's links survive being archived and installed somewhere else", async (t) => {
  const root = await bundle(t);
  assert.equal(await recordLinks(root), 1);
  assert.equal(
    await NodeFSP.lstat(join(root, "node_modules/@t3tools/contracts")).catch(() => null),
    null,
  );
  assert.ok(
    await NodeFSP.stat(join(root, "packages/contracts/src/index.ts")),
    "the target is kept",
  );
  assert.deepEqual(JSON.parse(await NodeFSP.readFile(join(root, linkManifest), "utf8")), [
    { path: "node_modules/@t3tools/contracts", target: "../../packages/contracts" },
  ]);

  const installed = `${root}-installed`;
  t.after(() => NodeFSP.rm(installed, { recursive: true, force: true }));
  await NodeFSP.rename(root, installed);
  await restoreLinks(installed);
  // Twice, as the installer does: staged, then again after the rename.
  await restoreLinks(installed);
  assert.equal(
    await NodeFSP.realpath(join(installed, "node_modules/@t3tools/contracts/src/index.ts")),
    join(await NodeFSP.realpath(installed), "packages/contracts/src/index.ts"),
  );
});

test("a link to a file becomes a copy, and one that leaves the bundle is dropped", async (t) => {
  const root = await bundle(t);
  await NodeFSP.writeFile(join(root, "LICENSE"), "MIT\n");
  await NodeFSP.symlink(join(root, "LICENSE"), join(root, "packages/contracts/LICENSE"));
  await NodeFSP.symlink(NodeOS.tmpdir(), join(root, "node_modules/outside"));
  assert.equal(await recordLinks(root), 1);
  assert.equal(await NodeFSP.readFile(join(root, "packages/contracts/LICENSE"), "utf8"), "MIT\n");
  assert.equal(
    (await NodeFSP.lstat(join(root, "packages/contracts/LICENSE"))).isSymbolicLink(),
    false,
  );
  assert.equal(await NodeFSP.lstat(join(root, "node_modules/outside")).catch(() => null), null);
});

test("a manifest cannot write outside its release or over real files", async (t) => {
  const root = await bundle(t);
  await recordLinks(root);
  await NodeFSP.writeFile(
    join(root, linkManifest),
    JSON.stringify([{ path: "../escaped", target: "packages" }]),
  );
  await assert.rejects(restoreLinks(root), /leaves the release/);
  await NodeFSP.writeFile(
    join(root, linkManifest),
    JSON.stringify([{ path: "x", target: "../../elsewhere" }]),
  );
  await assert.rejects(restoreLinks(root), /leaves the release/);
  await NodeFSP.writeFile(
    join(root, linkManifest),
    JSON.stringify([{ path: "packages/contracts", target: "../node_modules" }]),
  );
  await assert.rejects(restoreLinks(root), /replace real files/);
  assert.ok(await NodeFSP.stat(join(root, "packages/contracts/src/index.ts")));
});

test("a bundle without a manifest has nothing to restore", async (t) => {
  const root = await bundle(t);
  assert.equal(await restoreLinks(join(root, "packages")), 0);
});

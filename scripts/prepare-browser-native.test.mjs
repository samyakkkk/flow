import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { makeExecutable } from "./prepare-browser-native.mjs";

NodeTest.test("repairs the installed helper without changing a hard-linked store file", (t) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "flow-native-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const original = NodePath.join(root, "store-helper");
  const installed = NodePath.join(root, "installed-helper");
  NodeFS.writeFileSync(original, "helper fixture", { mode: 0o644 });
  NodeFS.linkSync(original, installed);
  makeExecutable(installed);
  NodeAssert.equal(NodeFS.statSync(installed).mode & 0o777, 0o755);
  NodeAssert.equal(NodeFS.statSync(original).mode & 0o777, 0o644);
  NodeAssert.equal(NodeFS.readFileSync(installed, "utf8"), "helper fixture");
  const inode = NodeFS.statSync(installed).ino;
  makeExecutable(installed);
  NodeAssert.equal(NodeFS.statSync(installed).ino, inode);
});

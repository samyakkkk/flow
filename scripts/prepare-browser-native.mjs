/* oxlint-disable t3code/no-global-process-runtime -- Standalone installation tooling reads the host before the app runtime exists. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";

// node-pty 1.1.0's macOS prebuild ships spawn-helper without executable bits.
// Replace the file before chmod: pnpm may hard-link it to its shared store.
export function makeExecutable(file) {
  const mode = NodeFS.statSync(file).mode & 0o777;
  if ((mode & 0o111) === 0o111) return;
  const temporary = `${file}.${NodeCrypto.randomUUID()}`;
  try {
    NodeFS.copyFileSync(file, temporary, NodeFS.constants.COPYFILE_EXCL);
    NodeFS.chmodSync(temporary, mode | 0o111);
    NodeFS.renameSync(temporary, file);
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

export function prepareBrowserNative(root) {
  if (NodeOS.platform() !== "darwin") return;
  const require = NodeModule.createRequire(NodePath.resolve(root, "apps/server/package.json"));
  const directory = NodePath.dirname(require.resolve("node-pty/package.json"));
  for (const relative of [
    `prebuilds/darwin-${NodeOS.arch()}/spawn-helper`,
    "build/Release/spawn-helper",
  ]) {
    const file = NodePath.join(directory, relative);
    if (NodeFS.existsSync(file)) makeExecutable(file);
  }
}

/* oxlint-disable t3code/no-global-process-runtime -- Build tool targets the host's native ABI. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { run } from "./flow-release.mjs";
import { prepareCpuLockfile } from "./prepare-browser-lockfile.mjs";
import { pruneBrowserBundle } from "./prune-browser-bundle.mjs";
import { buildBrowserGit, gitVersion } from "./build-browser-git.mjs";

const [sourceArg, outputArg, version] = process.argv.slice(2);
if (!sourceArg || !outputArg || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || "")) {
  throw Error("Usage: build-browser-bundle.mjs ARCHIVED_SOURCE OUTPUT X.Y.Z");
}
const platform = NodeOS.platform();
const architecture = NodeOS.arch();
const targetPlatform = `${platform}-${architecture}`;
if (!["darwin-arm64", "linux-x64"].includes(targetPlatform)) {
  throw Error("Build on Apple Silicon macOS or Linux x64.");
}
const source = NodePath.resolve(sourceArg);
const output = NodePath.resolve(outputArg);
if (await NodeFSP.stat(NodePath.join(source, ".git")).catch(() => null)) {
  throw Error("Use an isolated git archive, not a working checkout.");
}
await NodeFSP.mkdir(output, { recursive: true });
const temporary = await NodeFSP.mkdtemp(NodePath.join(output, ".bundle-"));
try {
  const nodeVersion = "24.13.1";
  const nodeName = `node-v${nodeVersion}-${targetPlatform}`;
  const nodeArchive = `${nodeName}.tar.gz`;
  const base = `https://nodejs.org/dist/v${nodeVersion}`;
  const download = async (name) => {
    const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw Error(`Could not download ${name}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  console.log("Downloading and verifying the private Node runtime…");
  const sums = (await download("SHASUMS256.txt")).toString();
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === nodeArchive)?.[0];
  const bytes = await download(nodeArchive);
  if (!expected || NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw Error("Node runtime checksum mismatch.");
  }
  const archive = NodePath.join(temporary, nodeArchive);
  await NodeFSP.writeFile(archive, bytes);
  const runtime = NodePath.join(source, "runtime");
  await NodeFSP.mkdir(runtime, { recursive: true });
  await run(
    "tar",
    [
      "-xzf",
      archive,
      "--strip-components=1",
      "-C",
      runtime,
      `${nodeName}/bin`,
      `${nodeName}/lib`,
      `${nodeName}/LICENSE`,
    ],
    source,
  );
  const node = NodePath.join(runtime, "bin/node");
  await buildBrowserGit(runtime, temporary);
  process.env.PATH = `${NodePath.join(runtime, "bin")}:${NodePath.join(runtime, "git/bin")}:${process.env.PATH || ""}`;
  for (const relative of ["apps/server", "apps/web", "apps/desktop", "packages/contracts"]) {
    const file = NodePath.join(source, relative, "package.json");
    const pkg = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    await NodeFSP.writeFile(file, JSON.stringify({ ...pkg, version }, null, 2) + "\n");
  }
  if (platform === "linux") await prepareCpuLockfile(source, temporary);
  await run("bash", [NodePath.join(source, "scripts/install-flow.sh"), "--build-only"], source);
  await run(node, [NodePath.join(source, "scripts/verify-browser-install.mjs")], source);
  await run(
    NodePath.join(source, "node_modules/.bin/vp"),
    [
      "test",
      "run",
      "apps/server/src/flowBrowserUpdate.test.ts",
      "apps/server/src/brain/BrainRuntime.clis.test.ts",
      "apps/server/src/provider/Layers/ProviderRegistry.test.ts",
      "apps/web/src/components/sidebar/flowBrowserUpdate.test.ts",
    ],
    source,
  );
  const { prepareNativeFalkor } = await import(
    NodeURL.pathToFileURL(NodePath.join(source, "apps/server/src/brain/native.ts"))
  );
  await prepareNativeFalkor(NodePath.join(runtime, "brain"), platform, architecture);
  if (platform === "darwin") {
    const iconset = NodePath.join(temporary, "Flow.iconset");
    await NodeFSP.mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        await run(
          "sips",
          [
            "-z",
            String(size * scale),
            String(size * scale),
            NodePath.join(source, "assets/brand/icon.png"),
            "--out",
            NodePath.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
          ],
          source,
        );
      }
    }
    await run(
      "iconutil",
      ["-c", "icns", iconset, "-o", NodePath.join(runtime, "Flow.icns")],
      source,
    );
  }
  await NodeFSP.writeFile(
    NodePath.join(source, "flow-bundle.json"),
    JSON.stringify({
      format: 1,
      tag: `flow-v${version}`,
      platform,
      arch: architecture,
      nodeVersion,
      gitVersion,
    }) + "\n",
  );
  await pruneBrowserBundle(source);
  await run(node, [NodePath.join(source, "apps/server/src/bin.ts"), "--version"], source);
  await run(node, [NodePath.join(source, "scripts/verify-browser-runtime.mjs")], source);
  // Preserve relative pnpm links; never include developer data or the git database.
  const name = `flow-browser-${targetPlatform}.tar.gz`;
  const target = NodePath.join(output, name);
  process.env.COPYFILE_DISABLE = "1";
  await run(
    "tar",
    [
      "-czf",
      target,
      "--no-xattrs",
      "--no-acls",
      "--exclude=.git",
      "--exclude=.t3",
      "--exclude=.repos",
      "-C",
      source,
      ".",
    ],
    source,
  );
  const digest = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(target))
    .digest("hex");
  await NodeFSP.writeFile(`${target}.sha256`, `${digest}  ${name}\n`);
  console.log(`Ready-built Flow ${version}: ${target}`);
} finally {
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}

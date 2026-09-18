/* oxlint-disable t3code/no-global-process-runtime -- Build tool targets the host's native ABI. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { bundledGit, bundledNode, run } from "./flow-release.mjs";
import { recordLinks } from "./bundle-links.mjs";
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
if (!["darwin-arm64", "linux-x64", "win32-x64"].includes(targetPlatform)) {
  throw Error("Build on Apple Silicon macOS, Linux x64 or Windows x64.");
}
// Windows connects to a Brain hosted elsewhere: FalkorDB has no Windows build.
// Its bundle carries Node, MinGit and the app, and no database.
const windows = platform === "win32";
// bsdtar ships with Windows and reads zip; the GNU tar Git Bash puts first on
// PATH does neither that nor drive-letter paths.
const tar = windows
  ? NodePath.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";
/** Run an npm-style `.cmd` shim, which Node only spawns through a shell. */
const runShim = (file, args, cwd) =>
  new Promise((resolve, reject) => {
    const quoted = [file, ...args].map((value) => (/[\s&^]/.test(value) ? `"${value}"` : value));
    const child = NodeChildProcess.spawn(quoted.join(" "), { cwd, stdio: "inherit", shell: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`${NodePath.basename(file)} failed (${code}).`)),
    );
  });
const sha256 = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const minGit = {
  version: "2.55.0.5",
  url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip",
  sha256: "56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e",
};
const source = NodePath.resolve(sourceArg);
const output = NodePath.resolve(outputArg);
if (await NodeFSP.stat(NodePath.join(source, ".git")).catch(() => null)) {
  throw Error("Use an isolated git archive, not a working checkout.");
}
await NodeFSP.mkdir(output, { recursive: true });
const temporary = await NodeFSP.mkdtemp(NodePath.join(output, ".bundle-"));
try {
  const nodeVersion = "24.13.1";
  const nodeName = `node-v${nodeVersion}-${windows ? "win-x64" : targetPlatform}`;
  const nodeArchive = `${nodeName}.${windows ? "zip" : "tar.gz"}`;
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
  if (!expected || sha256(bytes) !== expected) {
    throw Error("Node runtime checksum mismatch.");
  }
  const archive = NodePath.join(temporary, nodeArchive);
  await NodeFSP.writeFile(archive, bytes);
  const runtime = NodePath.join(source, "runtime");
  await NodeFSP.mkdir(runtime, { recursive: true });
  if (windows) {
    // The Windows zip keeps node.exe and npm at its top level.
    await NodeFSP.mkdir(NodePath.join(runtime, "bin"), { recursive: true });
    await run(
      tar,
      ["-xf", archive, "--strip-components=1", "-C", NodePath.join(runtime, "bin")],
      source,
    );
    console.log("Downloading and verifying MinGit…");
    const response = await fetch(minGit.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw Error(`Could not download MinGit: HTTP ${response.status}`);
    const git = Buffer.from(await response.arrayBuffer());
    if (sha256(git) !== minGit.sha256) throw Error("MinGit checksum mismatch.");
    const gitArchive = NodePath.join(temporary, "mingit.zip");
    await NodeFSP.writeFile(gitArchive, git);
    await NodeFSP.mkdir(NodePath.join(runtime, "git"), { recursive: true });
    await run(tar, ["-xf", gitArchive, "-C", NodePath.join(runtime, "git")], source);
  } else {
    await run(
      tar,
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
    await buildBrowserGit(runtime, temporary);
  }
  const node = bundledNode(source, windows);
  process.env.PATH = [
    NodePath.dirname(node),
    NodePath.dirname(bundledGit(source, windows)),
    process.env.PATH || "",
  ].join(NodePath.delimiter);
  for (const relative of ["apps/server", "apps/web", "apps/desktop", "packages/contracts"]) {
    const file = NodePath.join(source, relative, "package.json");
    const pkg = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    await NodeFSP.writeFile(file, JSON.stringify({ ...pkg, version }, null, 2) + "\n");
  }
  if (platform === "linux") await prepareCpuLockfile(source, temporary);
  if (windows) {
    // install-flow.sh's build, without a POSIX shell. pnpm's default layout
    // nests packages deep enough to pass Windows' 260-character path limit
    // once installed under a user profile; the hoisted layout stays short and
    // leaves only workspace packages as links.
    await NodeFSP.appendFile(NodePath.join(source, ".npmrc"), "\nnode-linker=hoisted\n");
    Object.assign(process.env, {
      FLOW_INSTALL_CPU: "current",
      FLOW_INSTALL_OS: "current",
      FLOW_INSTALL_LIBC: "current",
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    });
    const bootstrap = NodePath.join(temporary, "vp");
    await runShim(
      NodePath.join(runtime, "bin/npm.cmd"),
      [
        "install",
        "--prefix",
        bootstrap,
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "vite-plus@0.3.0",
        "@voidzero-dev/vite-plus-win32-x64-msvc@0.3.0",
      ],
      source,
    );
    await runShim(
      NodePath.join(bootstrap, "node_modules/.bin/vp.cmd"),
      [
        "install",
        "--frozen-lockfile",
        "--filter",
        "@t3tools/monorepo",
        "--filter",
        "t3...",
        "--filter",
        "@flow/brain-graph-gateway...",
        "--filter",
        "@flow/brain-orchestrator...",
      ],
      source,
    );
    await runShim(
      NodePath.join(source, "node_modules/.bin/vp.cmd"),
      ["run", "--filter", "@t3tools/web", "build"],
      source,
    );
  } else {
    await run("bash", [NodePath.join(source, "scripts/install-flow.sh"), "--build-only"], source);
  }
  await run(node, [NodePath.join(source, "scripts/verify-browser-install.mjs")], source);
  // Platform-independent logic, covered by the macOS and Linux builds. On
  // Windows `vp test run` never exits (it hung a CI job until its timeout), so
  // that build relies on the install and runtime verifiers instead.
  if (!windows)
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
  if (!windows) {
    const { prepareNativeFalkor } = await import(
      NodeURL.pathToFileURL(NodePath.join(source, "apps/server/src/brain/native.ts"))
    );
    await prepareNativeFalkor(NodePath.join(runtime, "brain"), platform, architecture);
  }
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
      gitVersion: windows ? minGit.version : gitVersion,
    }) + "\n",
  );
  // Pruning walks pnpm's virtual store, which the hoisted layout does not have.
  if (!windows) await pruneBrowserBundle(source);
  await run(node, [NodePath.join(source, "apps/server/src/bin.ts"), "--version"], source);
  await run(node, [NodePath.join(source, "scripts/verify-browser-runtime.mjs")], source);
  // Last, once nothing else needs to resolve a workspace package from here.
  if (windows) console.log(`Recorded ${await recordLinks(source)} directory links.`);
  // Preserve relative pnpm links; never include developer data or the git database.
  const name = `flow-browser-${targetPlatform}.tar.gz`;
  const target = NodePath.join(output, name);
  process.env.COPYFILE_DISABLE = "1";
  await run(
    tar,
    [
      "-czf",
      target,
      ...(windows ? [] : ["--no-xattrs", "--no-acls"]),
      "--exclude=.git",
      "--exclude=.t3",
      "--exclude=.repos",
      "-C",
      source,
      ".",
    ],
    source,
  );
  const digest = sha256(await NodeFSP.readFile(target));
  await NodeFSP.writeFile(`${target}.sha256`, `${digest}  ${name}\n`);
  console.log(`Ready-built Flow ${version}: ${target}`);
} finally {
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}

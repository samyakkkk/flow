/* oxlint-disable t3code/no-global-process-runtime -- Standalone bundle tooling tests the host platform. */
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import {
  validateRelease,
  verifyArchive,
  adoptBundle,
  installLauncher,
  releaseRuntime,
  stageRelease,
} from "./flow-release.mjs";
import { installMacApp } from "./flow-mac-app.mjs";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const name = "flow-browser-darwin-arm64.tar.gz";
NodeTest.test("selects the Mac bundle and verifies its exact asset/checksum names", () => {
  const release = {
    tag_name: "flow-v1.2.3",
    assets: [name, `${name}.sha256`, "flow-source.tar.gz", "flow-source.tar.gz.sha256"].map(
      (name) => ({
        name,
        browser_download_url: `https://github.com/samyakkkk/flow/releases/download/flow-v1.2.3/${name}`,
      }),
    ),
  };
  NodeAssert.equal(validateRelease(release, { platform: "darwin", arch: "arm64" }).assetName, name);
  NodeAssert.equal(
    validateRelease(release, { platform: "linux", arch: "x64" }).assetName,
    "flow-source.tar.gz",
  );
  const bytes = Buffer.from("bundle");
  const checksum = `${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
  verifyArchive(bytes, checksum, name);
  NodeAssert.throws(() => verifyArchive(bytes, checksum));
  NodeAssert.throws(() =>
    validateRelease(
      { ...release, assets: release.assets.filter((asset) => asset.name !== `${name}.sha256`) },
      { platform: "darwin", arch: "arm64" },
    ),
  );
});

async function fixture(t, tag = "flow-v1.0.0") {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-bundle-")),
  );
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const home = NodePath.join(root, "Flow's installation");
  const bundle = NodePath.join(home, "bootstrap");
  for (const dir of [
    "runtime/bin",
    "runtime/git/bin",
    "apps/web/dist",
    "apps/server/src",
    "scripts",
  ])
    await NodeFSP.mkdir(NodePath.join(bundle, dir), { recursive: true });
  await NodeFSP.symlink(process.execPath, NodePath.join(bundle, "runtime/bin/node"));
  await NodeFSP.symlink(process.execPath, NodePath.join(bundle, "runtime/git/bin/git"));
  await NodeFSP.writeFile(NodePath.join(bundle, "runtime/Flow.icns"), "icon fixture");
  await NodeFSP.writeFile(NodePath.join(bundle, "apps/web/dist/index.html"), "web fixture");
  await NodeFSP.writeFile(
    NodePath.join(bundle, "apps/server/src/bin.ts"),
    'console.log("fixture server");',
  );
  await NodeFSP.writeFile(
    NodePath.join(bundle, "scripts/flow-release.mjs"),
    "console.log(JSON.stringify(process.argv.slice(2)));",
  );
  await NodeFSP.writeFile(
    NodePath.join(bundle, "flow-bundle.json"),
    JSON.stringify({ format: 1, platform: NodeOS.platform(), arch: NodeOS.arch(), tag }),
  );
  await NodeFSP.writeFile(NodePath.join(bundle, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await NodeFSP.writeFile(NodePath.join(bundle, "scripts/flow.mjs"), "// launcher fixture\n");
  return { root, home, bundle, checksum: "a".repeat(64) };
}

NodeTest.test(
  "stages a checked prebuilt update without a build script and preserves selection on corruption",
  async (t) => {
    const f = await fixture(t);
    const selectedName = `flow-browser-${NodeOS.platform()}-${NodeOS.arch()}.tar.gz`;
    const archive = NodePath.join(f.root, selectedName);
    await execute("tar", ["-czf", archive, "-C", f.bundle, "."]);
    const bytes = await NodeFSP.readFile(archive);
    const checksum = `${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}  ${selectedName}\n`;
    const release = {
      tag: "flow-v1.0.0",
      assetName: selectedName,
      archiveUrl: "https://example.invalid/archive",
      checksumUrl: "https://example.invalid/checksum",
    };
    const fetcher = async (url) => new Response(url === release.archiveUrl ? bytes : checksum);
    await stageRelease(f.home, release, { fetcher });
    const selected = await NodeFSP.realpath(NodePath.join(f.home, "current"));
    NodeAssert.equal(
      NodePath.basename(selected),
      `flow-v1.0.0-${NodeOS.platform()}-${NodeOS.arch()}`,
    );
    await NodeAssert.rejects(
      stageRelease(
        f.home,
        { ...release, tag: "flow-v1.0.1" },
        {
          fetcher: async (url) =>
            new Response(url === release.archiveUrl ? Buffer.from("corrupt archive") : checksum),
        },
      ),
      /checksum/,
    );
    NodeAssert.equal(await NodeFSP.realpath(NodePath.join(f.home, "current")), selected);
    await NodeAssert.rejects(
      stageRelease(f.home, { ...release, tag: "flow-v1.0.1" }, { fetcher }),
      /version does not match/,
    );
    NodeAssert.equal(await NodeFSP.realpath(NodePath.join(f.home, "current")), selected);
  },
);

NodeTest.test(
  "adopts a prebuilt bundle without npm and creates a relocatable launcher and app",
  async (t) => {
    const f = await fixture(t);
    await adoptBundle(f.home, f.bundle, f.checksum);
    const runtime = await releaseRuntime(NodePath.join(f.home, "current"));
    NodeAssert.equal(runtime, NodePath.join(f.home, "current/runtime/bin/node"));
    const prefix = NodePath.join(f.root, "local prefix");
    await installLauncher(f.home, prefix);
    const result = await execute(NodePath.join(prefix, "bin/flow"), ["argument with spaces"], {
      env: { PATH: "/usr/bin:/bin" },
    });
    NodeAssert.deepEqual(JSON.parse(result.stdout), ["argument with spaces"]);
    const apps = NodePath.join(f.root, "Applications");
    const app = await installMacApp(f.home, apps);
    await execute(NodePath.join(app, "Contents/MacOS/Flow"), ["--no-open"], {
      env: { HOME: f.root, PATH: "/usr/bin:/bin" },
    });
    NodeAssert.match(
      await NodeFSP.readFile(NodePath.join(f.home, "launcher.log"), "utf8"),
      /--no-open/,
    );
    await installMacApp(f.home, apps);
    await NodeFSP.writeFile(
      NodePath.join(app, "Contents/flow-browser-launcher"),
      "another installation",
    );
    await NodeAssert.rejects(installMacApp(f.home, apps), /Another Flow/);
  },
);

NodeTest.test(
  "migrates a same-version source install without removing its active code or user data",
  async (t) => {
    const f = await fixture(t);
    const old = NodePath.join(f.home, "releases/flow-v1.0.0");
    await NodeFSP.mkdir(old, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(old, "flow-release.json"),
      JSON.stringify({ tag: "flow-v1.0.0", sha256: "old-source" }),
    );
    await NodeFSP.writeFile(NodePath.join(old, "active-server"), "keep running");
    await NodeFSP.symlink("releases/flow-v1.0.0", NodePath.join(f.home, "current"));
    await NodeFSP.writeFile(NodePath.join(f.home, "user-data"), "keep data");
    await adoptBundle(f.home, f.bundle, f.checksum);
    NodeAssert.notEqual(await NodeFSP.realpath(NodePath.join(f.home, "current")), old);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(old, "active-server"), "utf8"),
      "keep running",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.home, "user-data"), "utf8"),
      "keep data",
    );
  },
);

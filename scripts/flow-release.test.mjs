import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeFSP from "node:fs/promises";
const fs = NodeFSP;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodeCrypto from "node:crypto";
const { createHash } = NodeCrypto;
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import {
  validateRelease,
  verifyArchive,
  newerTag,
  stageRelease,
  installLauncher,
  selectPrimaryRelease,
  run,
  latestRelease,
  update,
} from "./flow-release.mjs";

function release(tag = "flow-v1.2.3") {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: ["flow-source.tar.gz", "flow-source.tar.gz.sha256"].map((name) => ({
      name,
      browser_download_url: `https://github.com/samyakkkk/flow/releases/download/${tag}/${name}`,
    })),
  };
}

test("accepts only stable Flow releases with both expected assets", () => {
  assert.equal(validateRelease(release()).tag, "flow-v1.2.3");
  for (const tag of ["v1.2.3", "flow-v1.2.3-beta", "flow-v01.2.3", "../elsewhere"])
    assert.throws(() => validateRelease(release(tag)));
  assert.throws(() => validateRelease({ ...release(), draft: true }));
  assert.throws(() => validateRelease({ ...release(), prerelease: true }));
  assert.throws(() => validateRelease({ ...release(), assets: [] }));
  const bad = release();
  bad.assets[0].browser_download_url = "https://example.com/file";
  assert.throws(() => validateRelease(bad));
});

test("compares numeric versions and never selects a downgrade", () => {
  assert.equal(newerTag("flow-v1.10.0", "flow-v1.9.0"), true);
  assert.equal(newerTag("flow-v1.9.0", "flow-v1.10.0"), false);
  assert.equal(newerTag("flow-v1.10.0", "flow-v1.10.0"), false);
  assert.equal(newerTag("flow-v1.0.0"), true);
});

test("rejects tampered archives and malformed checksum files", () => {
  const bytes = Buffer.from("release");
  const checksum = createHash("sha256").update(bytes).digest("hex") + "  flow-source.tar.gz\n";
  verifyArchive(bytes, checksum);
  assert.throws(() => verifyArchive(Buffer.from("other"), checksum), /checksum/);
  assert.throws(() => verifyArchive(bytes, checksum.replace("flow-source", "other")), /checksum/);
});

test("release lookup reports unavailable or rate-limited feeds", async () => {
  for (const status of [404, 403, 503]) {
    await assert.rejects(
      latestRelease(async () => new Response("unavailable", { status })),
      new RegExp(String(status)),
    );
  }
});

test("release lookup ignores desktop releases and selects the newest browser version", async () => {
  const result = await latestRelease(
    async () =>
      new Response(
        JSON.stringify([
          { ...release("flow-desktop-v9.0.0"), tag_name: "flow-desktop-v9.0.0" },
          release("flow-v1.9.0"),
          release("flow-v1.10.0"),
          { ...release("flow-v2.0.0"), prerelease: true },
        ]),
        { headers: { "Content-Type": "application/json" } },
      ),
  );

  assert.equal(result.tag, "flow-v1.10.0");
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "flow-release-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = join(root, "installation");
  const source = join(root, "source");
  for (const file of [
    "scripts/flow-release.mjs",
    "scripts/flow.mjs",
    "apps/server/src/bin.ts",
    "pnpm-lock.yaml",
  ]) {
    await fs.mkdir(join(source, file, ".."), { recursive: true });
    await fs.writeFile(join(source, file), "fixture");
  }
  const archive = join(root, "source.tar.gz");
  await run("tar", ["-czf", archive, "-C", source, "."], root);
  const bytes = await fs.readFile(archive);
  const checksum = createHash("sha256").update(bytes).digest("hex") + "  flow-source.tar.gz\n";
  const fetcher = async (url) => new Response(url.endsWith(".sha256") ? checksum : bytes);
  const build = async (directory) => {
    await fs.mkdir(join(directory, "apps/web/dist"), { recursive: true });
    await fs.writeFile(join(directory, "apps/web/dist/index.html"), "ready");
  };
  return { root, home, fetcher, build };
}

test("stages a verified release, retains the previous tree, and ignores older releases", async (t) => {
  const f = await fixture(t);
  const first = validateRelease(release("flow-v1.0.0"));
  await stageRelease(f.home, first, f);
  await stageRelease(f.home, validateRelease(release("flow-v1.1.0")), f);
  assert.equal(await fs.realpath(join(f.home, "current")), join(f.home, "releases/flow-v1.1.0"));
  await fs.access(join(f.home, "releases/flow-v1.0.0/apps/web/dist/index.html"));
  const noDownload = {
    ...f,
    fetcher: () => {
      throw Error("unexpected download");
    },
  };
  await stageRelease(f.home, first, noDownload);
  await stageRelease(f.home, validateRelease(release("flow-v1.1.0")), noDownload);
});

test("failed build or checksum keeps the selected release and removes temporary data", async (t) => {
  const f = await fixture(t);
  await stageRelease(f.home, validateRelease(release("flow-v1.0.0")), f);
  await assert.rejects(
    stageRelease(f.home, validateRelease(release()), {
      ...f,
      build: () => {
        throw Error("build failed");
      },
    }),
    /build failed/,
  );
  await assert.rejects(
    stageRelease(f.home, validateRelease(release()), {
      ...f,
      fetcher: async () => new Response("corrupt"),
    }),
    /checksum/,
  );
  assert.equal(await fs.realpath(join(f.home, "current")), join(f.home, "releases/flow-v1.0.0"));
  assert.deepEqual(await fs.readdir(join(f.home, "releases")), ["flow-v1.0.0"]);
});

test("running primary keeps its code; stopped primary adopts release with identity and data intact", async (t) => {
  const f = await fixture(t);
  await stageRelease(f.home, validateRelease(release("flow-v1.0.0")), f);
  const directory = join(f.root, "registry/instances/primary");
  await fs.mkdir(directory, { recursive: true });
  const config = {
    id: "same-id",
    code: join(f.home, "releases/flow-v1.0.0"),
    home: "unchanged-data",
    mode: "isolated",
  };
  await fs.writeFile(join(directory, "config.json"), JSON.stringify(config));
  await stageRelease(f.home, validateRelease(release()), f);
  const selection = {
    directory,
    home: f.home,
    launcher: { control: async () => ({ phase: "ready" }) },
  };
  assert.equal(await selectPrimaryRelease(selection), config.code);
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, "config.json"))), config);
  selection.launcher.control = async () => null;
  const code = await selectPrimaryRelease(selection);
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, "config.json"))), {
    ...config,
    code,
  });
  assert.equal(code, join(f.home, "releases/flow-v1.2.3"));
  await fs.writeFile(
    join(directory, "config.json"),
    JSON.stringify({ ...config, code: "/developer/checkout" }),
  );
  await assert.rejects(selectPrimaryRelease(selection), /source checkout/);
});

test("installed launcher follows current symlink and preserves shell arguments in paths with quotes", async (t) => {
  const f = await fixture(t);
  const home = join(f.root, "Flow's release home");
  const prefix = join(f.root, "local prefix");
  const entry = join(home, "releases/one/scripts");
  await fs.mkdir(entry, { recursive: true });
  await fs.writeFile(
    join(entry, "flow-release.mjs"),
    `import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify({home:process.env.FLOW_RELEASE_HOME,args:process.argv.slice(3)}));`,
  );
  await fs.symlink("releases/one", join(home, "current"));
  await installLauncher(home, prefix);
  const output = join(f.root, "args.json");
  await run(join(prefix, "bin/flow"), [output, "a b", "$(literal)"], f.root);
  assert.deepEqual(JSON.parse(await fs.readFile(output)), { home, args: ["a b", "$(literal)"] });
  await fs.writeFile(join(prefix, "bin/flow"), "unrelated command");
  await assert.rejects(installLauncher(home, prefix), /Refusing/);
});

test("an unreachable supervisor that still holds ownership cannot have its code switched", async (t) => {
  const f = await fixture(t);
  await stageRelease(f.home, validateRelease(release("flow-v1.0.0")), f);
  const directory = join(f.root, "primary");
  await fs.mkdir(directory);
  const config = { code: join(f.home, "releases/flow-v1.0.0"), id: "still-running" };
  await fs.writeFile(join(directory, "config.json"), JSON.stringify(config));
  await stageRelease(f.home, validateRelease(release()), f);
  const ownership = new NodeSqlite.DatabaseSync(join(directory, "supervisor-lock.sqlite"));
  try {
    ownership.exec("BEGIN EXCLUSIVE");
    const selected = await selectPrimaryRelease({
      directory,
      home: f.home,
      launcher: { control: async () => null },
    });
    assert.equal(selected, config.code);
    assert.deepEqual(JSON.parse(await fs.readFile(join(directory, "config.json"))), config);
  } finally {
    ownership.close();
  }
});

test("a concurrent updater cannot enter staging", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.home);
  const lock = new NodeSqlite.DatabaseSync(join(f.home, "update-lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
    await assert.rejects(update(f.home), /Another Flow update/);
    await assert.rejects(fs.access(join(f.home, "last-check.json")));
  } finally {
    lock.close();
  }
});

test("the real CLI entry runs through a current symlink", async (t) => {
  const f = await fixture(t);
  const scripts = join(f.home, "releases/one/scripts");
  await fs.mkdir(scripts, { recursive: true });
  await fs.copyFile(
    NodeURL.fileURLToPath(new URL("./flow-release.mjs", import.meta.url)),
    join(scripts, "flow-release.mjs"),
  );
  await fs.symlink("releases/one", join(f.home, "current"));
  await assert.rejects(
    NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      [join(f.home, "current/scripts/flow-release.mjs"), "update", "--invalid"],
      { env: { ...process.env, FLOW_RELEASE_HOME: f.home } },
    ),
    (error) => error.code === 1 && error.stderr.includes("Usage: flow update"),
  );
});

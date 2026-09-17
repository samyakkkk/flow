import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeFSP from "node:fs/promises";
const { mkdtemp, mkdir, rm } = NodeFSP;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import { parse, configure, sourceRoot, installedDesktopApp } from "./launcher.mjs";
import { cleanEnvironment } from "./supervisor.mjs";
test("normal launch does not depend on instance arguments", () => {
  assert.equal(parse([]).name, "primary");
  assert.throws(() => parse(["--isolated"]), /development|dev/);
});
test("an explicit home is recorded once and never moved afterwards", async () => {
  assert.equal(parse(["--home", "/srv/flow"]).home, "/srv/flow");
  assert.throws(() => parse(["--home"]), /requires a value/);
  assert.throws(() => parse(["stop", "--home", "/srv/flow"]), /only when starting/);
  const directory = await mkdtemp(join(tmpdir(), "flow-home-test-"));
  try {
    const adopted = join(directory, "adopted");
    const saved = await configure(parse(["--home", adopted]), directory);
    assert.equal(saved.home, adopted);
    assert.deepEqual(await configure(parse([]), directory), saved);
    await assert.rejects(
      configure(parse(["--home", join(directory, "elsewhere")]), directory),
      /never moved/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("the launcher records its runtime and backfills older registries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flow-node-test-"));
  try {
    const saved = await configure(parse([]), directory);
    assert.equal(saved.node, process.execPath);
    // A registry written before `node` existed gains it on the next launch and
    // changes nothing else.
    const { node: _node, ...older } = saved;
    await NodeFSP.writeFile(join(directory, "config.json"), JSON.stringify(older));
    const reopened = await configure(parse([]), directory);
    assert.deepEqual(reopened, saved);
    assert.equal(
      JSON.parse(await NodeFSP.readFile(join(directory, "config.json"), "utf8")).node,
      process.execPath,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("flow prefers an installed desktop app only on macOS and only in the app folders", async () => {
  assert.equal(parse(["--browser"]).browser, true);
  const home = await mkdtemp(join(tmpdir(), "flow-app-test-"));
  try {
    const system = join(home, "system-applications");
    assert.equal(await installedDesktopApp("darwin", home, system), null);
    assert.equal(await installedDesktopApp("linux", home, system), null);
    await mkdir(join(home, "Applications/Flow.app/Contents/MacOS"), { recursive: true });
    await NodeFSP.writeFile(join(home, "Applications/Flow.app/Contents/MacOS/Flow"), "");
    assert.equal(
      await installedDesktopApp("darwin", home, system),
      join(home, "Applications/Flow.app"),
    );
    assert.equal(await installedDesktopApp("linux", home, system), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("storage defaults to the instance directory when no home is given", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flow-home-default-test-"));
  try {
    const saved = await configure(parse(["dev", "test1", "--code", sourceRoot]), directory);
    assert.equal(saved.home, join(directory, "data"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("mode and destructive flag conflicts are rejected", () => {
  assert.throws(() => parse(["dev", "test1", "--isolated", "--shared-brain"]), /one/);
  assert.throws(() => parse(["dev", "test1", "--fresh", "--replace"]), /fresh/);
  assert.throws(() => parse(["dev", "../primary"]), /name/);
  assert.throws(() => parse(["dev", "primary"]), /name/);
  assert.equal(parse(["dev", "test1", "--replace"]).replace, true);
});
test("reopening preserves code, identity and storage, and fresh never overwrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flow-config-test-"));
  try {
    const input = parse(["dev", "test1", "--isolated", "--code", sourceRoot]);
    const saved = await configure(input, directory);
    assert.deepEqual(await configure(parse(["dev", "test1", "--replace"]), directory), saved);
    await assert.rejects(
      configure(parse(["dev", "test1", "--fresh"]), directory),
      /already exists/,
    );
    await assert.rejects(
      configure(parse(["dev", "test1", "--shared-brain"]), directory),
      /different brain/,
    );
    const other = join(directory, "other");
    await mkdir(other);
    const second = await configure(parse(["dev", "test2", "--code", sourceRoot]), other);
    assert.notEqual(second.id, saved.id);
    assert.notEqual(second.home, saved.home);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("nested launches cannot inherit parent storage or brain routing", () => {
  assert.deepEqual(
    cleanEnvironment({
      HOME: "/home/user",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "shared",
      T3CODE_HOME: "/daily",
      FLOW_SHARED_BRAIN_HOME: "/daily",
      FALKOR_SOCKET: "/daily.sock",
      PORT: "123",
      VITE_WS_URL: "daily",
    }),
    { HOME: "/home/user", PATH: "/bin", ANTHROPIC_API_KEY: "shared" },
  );
});
NodeTest.test("guardian stops a child when its supervisor disconnects", async () => {
  const { fork } = await import("node:child_process");
  const { once } = await import("node:events");
  const { setTimeout: delay } = await import("node:timers/promises");
  const root = await mkdtemp(join(tmpdir(), "flow-guardian-test-"));
  const marker = join(root, "stopped");
  const guardian = fork(
    join(sourceRoot, "scripts/instances/child-guard.mjs"),
    [
      process.execPath,
      "-e",
      `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(process.argv[1],'stopped');process.exit(0)});process.stdout.write('ready');setInterval(()=>{},1000)`,
      marker,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  try {
    await once(guardian.stdout, "data");
    guardian.disconnect();
    for (let i = 0; i < 100; i++) {
      try {
        await NodeFSP.access(marker);
        break;
      } catch {
        await delay(20);
      }
    }
    assert.equal(await NodeFSP.readFile(marker, "utf8"), "stopped");
  } finally {
    const exited = once(guardian, "exit");
    process.kill(-guardian.pid, "SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

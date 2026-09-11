/* oxlint-disable t3code/no-global-process-runtime -- Standalone packaged-runtime smoke test. */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeUtil from "node:util";

const root = await NodeFSP.realpath(process.argv[2] || ".");
const require = NodeModule.createRequire(NodePath.join(root, "apps/server/package.json"));
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const git = NodePath.join(root, "runtime/git/bin/git");
const gitHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-git-"));
try {
  const env = {
    PATH: `${NodePath.dirname(git)}:/usr/bin:/bin`,
    HOME: gitHome,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const invoke = (args) => execute(git, args, { cwd: gitHome, env });
  NodeAssert.ok(
    (await invoke(["--exec-path"])).stdout.trim().startsWith(NodePath.join(root, "runtime/git/")),
  );
  await invoke(["init", "--initial-branch=main", "repo"]);
  await NodeFSP.writeFile(NodePath.join(gitHome, "repo/example.txt"), "bundled git works\n");
  await invoke(["-C", "repo", "add", "."]);
  await invoke([
    "-C",
    "repo",
    "-c",
    "user.name=Flow Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Verify bundled Git",
  ]);
  await invoke(["clone", "repo", "clone"]);
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(gitHome, "clone/example.txt"), "utf8"),
    "bundled git works\n",
  );
  await invoke(["-C", "repo", "worktree", "add", "../worktree", "-b", "test"]);
  NodeAssert.equal((await invoke(["-C", "worktree", "status", "--porcelain"])).stdout, "");
} finally {
  await NodeFSP.rm(gitHome, { recursive: true, force: true });
}
const Database = require("better-sqlite3");
const database = new Database(":memory:");
try {
  NodeAssert.equal(database.prepare("select 42 as answer").get().answer, 42);
} finally {
  database.close();
}
await new Promise((resolve, reject) => {
  const terminal = require("node-pty").spawn("/bin/sh", ["-c", "printf FLOW_RUNTIME_OK"], {
    name: "xterm",
    cols: 80,
    rows: 24,
    cwd: root,
  });
  const timer = setTimeout(() => {
    terminal.kill();
    reject(Error("Terminal startup timed out"));
  }, 10_000);
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    try {
      NodeAssert.equal(exitCode, 0);
      NodeAssert.match(output, /FLOW_RUNTIME_OK/);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
const { originalBrainTools } = await import(
  NodeURL.pathToFileURL(NodePath.join(root, "apps/server/src/brain/session-worker.ts"))
);
const tools = await originalBrainTools();
NodeAssert.ok(tools.length > 0, "Brain worker must load its tool catalog");
const { getLlama } = await import(NodeURL.pathToFileURL(require.resolve("node-llama-cpp")));
const llama = await getLlama({ gpu: "auto" });
await llama.dispose();
const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-runtime-"));
let child, ended, client;
try {
  const { prepareNativeFalkor } = await import(
    NodeURL.pathToFileURL(NodePath.join(root, "apps/server/src/brain/native.ts"))
  );
  const native = await prepareNativeFalkor(temporary, NodeOS.platform(), NodeOS.arch());
  NodeAssert.ok(
    native.redisServerPath.startsWith(NodePath.join(root, "runtime/brain")) ||
      (NodeOS.platform() === "linux" && native.redisServerPath.startsWith(temporary)),
    "Must use the bundled database, not download one",
  );
  const socket = NodePath.join(temporary, "db.sock");
  child = NodeChildProcess.spawn(
    native.redisServerPath,
    [
      "--port",
      "0",
      "--unixsocket",
      socket,
      "--save",
      "",
      "--appendonly",
      "no",
      "--loadmodule",
      native.modulePath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  ended = NodeEvents.once(child, "exit");
  await new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(Error(`Database startup timed out: ${log}`)), 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Database exited before readiness (${code}): ${log}`));
    });
    child.stdout.on("data", (data) => {
      log += data;
      if (log.includes("Ready to accept connections")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (data) => {
      log += data;
    });
  });
  client = await require("falkordb").FalkorDB.connect({
    socket: { path: socket, reconnectStrategy: false },
  });
  const result = await client.selectGraph("runtime_smoke").query("RETURN 42 AS answer");
  NodeAssert.equal(result.data[0].answer, 42);
} finally {
  if (client) await client.close();
  if (child) {
    child.kill("SIGTERM");
    await ended;
  }
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}
console.log(
  `Packaged runtime passed: Git commit/clone/worktree, SQLite, terminal, ${tools.length} Brain tools, llama, and native graph query.`,
);

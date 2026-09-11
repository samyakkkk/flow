import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseArgs } from "node:util";

// Exercise the CLI update boundary without pulling or restarting a real install.
const source = readFileSync(new URL("../../bin/flow.mjs", import.meta.url), "utf8");
const start = source.indexOf("function maybeSelfUpdate() {");
const end = source.indexOf("\n// Commit the running code", start);
const updater = source.slice(start, end);

const dashboardSource = readFileSync(new URL("../../dashboard/src/app/api/update-status/route.ts", import.meta.url), "utf8");
const dashboardStart = dashboardSource.indexOf("async function checkUpstream()");
const dashboardEnd = dashboardSource.indexOf("\n// Identifies THIS dashboard process", dashboardStart);
const dashboardChecker = dashboardSource
  .slice(dashboardStart, dashboardEnd)
  .replace(": Promise<UpdateStatus>", "")
  .replace(": UpdateStatus =", " =");

function runUpdate(env = {}, branch = "main") {
  const calls = [];
  const context = {
    LEGACY_UPDATE_BRANCH: "main-legacy",
    LEGACY_UPDATE_REF: "origin/main-legacy",
    flowRoot: "/checkout", existsSync: () => true, join: (...parts) => parts.join("/"),
    console: { log() {} }, c: { dim: s => s }, OK: "ok", FAIL: "fail",
    process: { env, execPath: process.execPath, argv: [process.execPath, "/checkout/bin/flow.mjs", "up", "olostep"], exit: () => {} },
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (command !== "git") return { status: 0 };
      let stdout = "";
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") stdout = branch;
      if (args[0] === "rev-list") stdout = "1";
      if (args[0] === "rev-parse" && args[1] === "HEAD:package-lock.json") stdout = "unchanged-lock";
      return { status: 0, stdout };
    },
  };
  runInNewContext(`${updater}\nmaybeSelfUpdate();`, context);
  return calls;
}

async function runDashboardCheck(branch = "main") {
  const calls = [];
  const context = {
    LEGACY_UPDATE_BRANCH: "main-legacy",
    LEGACY_UPDATE_REF: "origin/main-legacy",
    FLOW_ROOT: "/checkout",
    Date,
    existsSync: () => true,
    join: (...parts) => parts.join("/"),
    async git(args) {
      calls.push(args);
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return branch;
      if (args[0] === "status") return "";
      if (args[0] === "rev-list") return "2";
      if (args.join(" ") === "rev-parse --short HEAD") return "current";
      if (args.join(" ") === "rev-parse --short origin/main-legacy") return "legacy-latest";
      return "";
    },
  };
  const result = await runInNewContext(`${dashboardChecker}\ncheckUpstream();`, context);
  return { calls, result };
}

test("self-update guards only the re-executed invocation, leaving future dashboard installs enabled", () => {
  const calls = runUpdate({ PATH: "/usr/bin", FLOW_PROJECT: "olostep" });
  const child = calls.find(call => call.command === process.execPath);
  assert.ok(child, "successful fast-forward re-executes the CLI");
  const parsed = parseArgs({ args: Array.from(child.args).slice(2), allowPositionals: true, options: { "no-update": { type: "boolean" } } });
  assert.equal(parsed.values["no-update"], true);
  assert.deepEqual(parsed.positionals, ["olostep"]);
  assert.equal(child.options.env.FLOW_NO_UPDATE, undefined);
  assert.equal(child.options.env.FLOW_PROJECT, "olostep");
  // A later invocation inherits service env, not its parent's argv.
  assert.ok(runUpdate(child.options.env).some(call =>
    call.command === "git" && call.args.join(" ") === "merge --ff-only --quiet origin/main-legacy"
  ));
});

test("explicit CLI opt-out still suppresses automatic pulls", () => {
  assert.equal(runUpdate({ FLOW_NO_UPDATE: "1" }).length, 0);
});

test("legacy updates never consult origin/main, even during the local-main transition", () => {
  for (const branch of ["main", "master", "main-legacy"]) {
    const calls = runUpdate({}, branch).filter(call => call.command === "git");
    assert.ok(calls.some(call => call.args.join(" ") === "fetch --quiet origin main-legacy"));
    assert.ok(calls.some(call => call.args.join(" ") === "rev-list --count HEAD..origin/main-legacy"));
    assert.ok(calls.some(call => call.args.join(" ") === "merge --ff-only --quiet origin/main-legacy"));
    assert.ok(calls.every(call => !call.args.some(arg => arg === "@{u}" || arg === "origin/main")));
  }
});

test("feature branches remain outside the legacy update channel", () => {
  const calls = runUpdate({}, "feature/new-flow");
  assert.ok(calls.every(call => call.command !== "git" || call.args[0] !== "fetch"));
});

test("dashboard checks the same isolated legacy ref", async () => {
  for (const branch of ["main", "master", "main-legacy"]) {
    const { calls, result } = await runDashboardCheck(branch);
    assert.equal(result.behind, 2);
    assert.equal(result.latest, "legacy-latest");
    assert.ok(calls.some(args => args.join(" ") === "fetch --quiet origin main-legacy"));
    assert.ok(calls.some(args => args.join(" ") === "rev-list --count HEAD..origin/main-legacy"));
    assert.ok(calls.every(args => !args.some(arg => arg === "@{u}" || arg === "origin/main")));
  }
});

test("dashboard does not offer legacy updates on feature branches", async () => {
  const { calls, result } = await runDashboardCheck("feature/new-flow");
  assert.equal(result.behind, 0);
  assert.ok(calls.every(args => args[0] !== "fetch"));
});

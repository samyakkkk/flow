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

function runUpdate(env = {}) {
  const calls = [];
  const context = {
    flowRoot: "/checkout", existsSync: () => true, join: (...parts) => parts.join("/"),
    console: { log() {} }, c: { dim: s => s }, OK: "ok", FAIL: "fail",
    process: { env, execPath: process.execPath, argv: [process.execPath, "/checkout/bin/flow.mjs", "up", "olostep"], exit: () => {} },
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (command !== "git") return { status: 0 };
      let stdout = "";
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") stdout = args[2] === "HEAD" ? "main" : "origin/main";
      if (args[0] === "rev-list") stdout = "1";
      if (args[0] === "rev-parse" && args[1] === "HEAD:package-lock.json") stdout = "unchanged-lock";
      return { status: 0, stdout };
    },
  };
  runInNewContext(`${updater}\nmaybeSelfUpdate();`, context);
  return calls;
}

test("self-update guards only the re-executed invocation, leaving future dashboard installs enabled", () => {
  const calls = runUpdate({ PATH: "/usr/bin", FLOW_PROJECT: "olostep" });
  const child = calls.find(call => call.command === process.execPath);
  assert.ok(child, "successful pull re-executes the CLI");
  const parsed = parseArgs({ args: Array.from(child.args).slice(2), allowPositionals: true, options: { "no-update": { type: "boolean" } } });
  assert.equal(parsed.values["no-update"], true);
  assert.deepEqual(parsed.positionals, ["olostep"]);
  assert.equal(child.options.env.FLOW_NO_UPDATE, undefined);
  assert.equal(child.options.env.FLOW_PROJECT, "olostep");
  // A later invocation inherits service env, not its parent's argv.
  assert.ok(runUpdate(child.options.env).some(call => call.command === "git" && call.args[0] === "pull"));
});

test("explicit CLI opt-out still suppresses automatic pulls", () => {
  assert.equal(runUpdate({ FLOW_NO_UPDATE: "1" }).length, 0);
});

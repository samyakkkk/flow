#!/usr/bin/env node
// Exercise setup in a fresh HOME with no local Flow project registry/config.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const name = process.argv[2];
const project = JSON.parse(readFileSync(join(homedir(), ".flow/config.json"), "utf8")).projects?.[name];
assert.ok(project?.token, "Pass an existing test project");
const home = mkdtempSync(join(tmpdir(), "flow-remote-setup-"));
const repo = join(home, "repo with spaces");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
const env = { ...process.env, HOME: home, FLOW_SETUP_TEST_TOKEN: project.token };
const client = new Client({ name: "flow-setup-smoke", version: "1" });
try {
  execFileSync(process.execPath, [new URL("../bin/flow.mjs", import.meta.url).pathname,
    "setup", name, "--gateway-url", project.gatewayUrl,
    "--orchestrator-url", project.orchestratorUrl,
    "--token-env", "FLOW_SETUP_TEST_TOKEN", "--repo", "harness-fixture", "--harness", "claude"],
  { cwd: repo, env, stdio: "pipe", timeout: 30000 });
  const path = join(home, ".flow/config.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")).projects[name];
  assert.ok(cfg.mcpUrl);
  assert.equal(cfg.gatewayMcp, undefined);
  assert.equal(cfg.falkorHost, undefined);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(repo, ".mcp.json"), "utf8").includes(project.token));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(home, ".flow/bin/flow-mcp"), "--project", name, "--repo", "harness-fixture"],
    cwd: repo, env, stderr: "pipe" });
  await client.connect(transport);
  const result = await client.callTool({ name: "orient", arguments: {} });
  assert.ok(!result.isError);
  assert.match(JSON.stringify(result), /harness-fixture/);
  const cli = execFileSync(process.execPath, [join(home, ".flow/bin/flow"), "orient"], { cwd: repo, env, encoding: "utf8", timeout: 20000 });
  assert.ok(!cli.includes("FLOW UNAVAILABLE"));
  assert.ok(cli.includes(`project "${name}"`));
  console.log("PASS: fresh-home remote setup, private credentials, no local database config, stdio-to-HTTP MCP, and CLI fallback");
} finally {
  await client.close();
  rmSync(home, { recursive: true, force: true });
}

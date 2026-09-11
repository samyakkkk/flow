#!/usr/bin/env node
// Read-only protocol/security smoke test. Credentials stay in machine config.
// Usage: node scripts/check-remote-mcp.mjs <configured-project>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const project = JSON.parse(readFileSync(join(homedir(), ".flow/config.json"), "utf8")).projects?.[process.argv[2]];
assert.ok(project?.gatewayUrl && project?.token, "Pass a configured project with credentials");
const url = new URL(project.mcpUrl ?? `${project.gatewayUrl.replace(/\/$/, "")}/mcp`);
const headers = { authorization: `Bearer ${project.token}` };
const request = (extra = {}) => fetch(url, {
  method: "POST", headers: { "content-type": "application/json", ...extra },
  body: "{}", signal: AbortSignal.timeout(10000), redirect: "error",
});
assert.equal((await request()).status, 401, "unauthenticated request must fail");
assert.equal((await request({ ...headers, origin: "https://untrusted.invalid" })).status, 403, "untrusted Origin must fail");
const client = new Client({ name: "flow-remote-smoke", version: "1" });
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(t => t.name === "orient"));
  assert.ok(!tools.some(t => ["upsert_entity", "upsert_relation", "merge_entities"].includes(t.name)));
  const schema = await client.callTool({ name: "list_schema", arguments: {} });
  assert.ok(!schema.isError, "authorized schema read succeeds");
  const foreign = await client.callTool({ name: "find_entity", arguments: { q: "boundary-test", graph: `${project.graphName}-foreign` } });
  assert.equal(foreign.isError, true, "foreign graph must fail");
  const write = await client.callTool({ name: "upsert_entity", arguments: {} });
  assert.equal(write.isError, true, "write tools must be unavailable");
  console.log("PASS: authenticated MCP initialization, tool discovery, read, project boundary, write exclusion, missing auth and Origin rejection");
} finally {
  await client.close();
}

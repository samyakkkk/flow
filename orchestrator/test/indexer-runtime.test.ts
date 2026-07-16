import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-project-token";
process.env.GATEWAY_URL = "http://127.0.0.1:7999/";

test("indexer MCP borrows the project gateway embedding model", async () => {
  const { mcpEnv } = await import("../src/indexer-runtime.js");
  const env = mcpEnv({ graphName: "test-graph" });
  assert.equal(env.FLOW_EMBED_URL, "http://127.0.0.1:7999/v1/embed");
  assert.equal(env.FLOW_EMBED_TOKEN, "test-project-token");
  assert.equal(env.GRAPH_NAME, "test-graph");
});

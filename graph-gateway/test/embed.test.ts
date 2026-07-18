import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

let server: Server;
let embedQuery: (text: string) => Promise<{ vec: number[] | null; error?: string }>;
let requests = 0;

before(async () => {
  server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer scoped-embed-token");
    requests++;
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: true, dim: 768, vec: Array(768).fill(0.25) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  process.env.FLOW_EMBED_URL = `http://127.0.0.1:${address.port}/v1/embed`;
  process.env.FLOW_EMBED_TOKEN = "scoped-embed-token";
  ({ embedQuery } = await import("../src/embed.js"));
});

after(async () => {
  delete process.env.FLOW_EMBED_URL;
  delete process.env.FLOW_EMBED_TOKEN;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test("MCP process borrows the gateway embedding model", async () => {
  const result = await embedQuery("semantic lookup intent");
  assert.equal(result.error, undefined);
  assert.equal(result.vec?.length, 768);
  assert.equal(requests, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Fastify from "fastify";

test("personal connector credentials allow capture but cannot start agents or administer projects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-pat-test-"));
  const path = join(dir, "auth.json");
  process.env.FLOW_AUTH_PATH = path;
  process.env.FLOW_PROJECT_NAME = "team-a";
  process.env.FLOW_ADMIN_TOKEN = "test-admin";
  const secret = "1234567890abcdef1234567890abcdef";
  const token = `flowpat_12345678_${secret}`;
  writeFileSync(path, JSON.stringify({ users: [{ id: "person", role: "member" }],
    grants: { person: ["team-a"] },
    tokens: [{ id: "12345678", userId: "person", hash: createHash("sha256").update(secret).digest("hex") }] }));
  const { requireAuth } = await import("../src/auth.js");
  const app = Fastify();
  app.addHook("onRequest", (req, reply, done) => requireAuth(req, reply, done));
  for (const url of ["/v1/ingest/hook", "/v1/memory/search", "/v1/agents/start", "/v1/settings"]) {
    app.post(url, async () => ({ ok: true }));
  }
  app.get("/v1/connection", async () => ({ ok: true }));
  try {
    const call = (url: string, credential = token) => app.inject({ method: "POST", url, headers: { authorization: `Bearer ${credential}` } });
    assert.equal((await call("/v1/ingest/hook")).statusCode, 200);
    assert.equal((await call("/v1/memory/search")).statusCode, 200);
    assert.equal((await call("/v1/agents/start")).statusCode, 403);
    assert.equal((await call("/v1/settings")).statusCode, 403);
    assert.equal((await call("/v1/agents/start", "test-admin")).statusCode, 200);
    assert.equal((await call("/v1/ingest/hook", token.slice(0, -1) + "0")).statusCode, 401);
    writeFileSync(path, JSON.stringify({ users: [{ id: "person", role: "member" }], grants: {}, tokens: [] }));
    assert.equal((await call("/v1/ingest/hook")).statusCode, 401, "revocation takes effect");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

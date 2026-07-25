// llm.test.ts — the shared single-shot LLM transport layer. Fully offline: the
// http transport talks to a local fake OpenAI-compatible server; the cli
// transport is never spawned (transport is forced to http via env).

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

// Env BEFORE importing anything that touches the DB.
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-admin-token-llm";
process.env.LLM_TRANSPORT = "http";
process.env.LLM_API_KEY = "test-llm-key";

/* eslint-disable @typescript-eslint/no-explicit-any */
let llm: typeof import("../src/llm.js");
let memoryLlm: typeof import("../src/memory/llm.js");
let settings: typeof import("../src/settings.js");
let db: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let server: Server;
interface SeenRequest {
  auth: string | undefined;
  model: string;
  prompt: string;
}
let seen: SeenRequest[] = [];
let replyWith = "fake completion text";
let replyStatus = 200;

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    seen.push({ auth: req.headers.authorization, model: body.model, prompt: body.messages[0]?.content ?? "" });
    res.writeHead(replyStatus, { "content-type": "application/json" });
    res.end(
      replyStatus === 200
        ? JSON.stringify({ choices: [{ message: { content: replyWith } }] })
        : JSON.stringify({ error: "boom" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fake LLM server did not bind");
  process.env.LLM_BASE_URL = `http://127.0.0.1:${addr.port}`;

  db = (await import("../src/db.js")).default;
  llm = await import("../src/llm.js");
  memoryLlm = await import("../src/memory/llm.js");
  settings = await import("../src/settings.js");
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  seen = [];
  replyWith = "fake completion text";
  replyStatus = 200;
  db.exec("DELETE FROM llm_log");
});

describe("shared LLM transport layer", () => {
  test("forced http: completes, sends bearer key, uses the smart-tier default model", async () => {
    const text = await llm.complete("say hi", { tier: "smart", feature: "distiller" });
    assert.equal(text, "fake completion text");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, "Bearer test-llm-key");
    assert.equal(seen[0].model, "anthropic/claude-sonnet-4.6");
    assert.equal(seen[0].prompt, "say hi");
  });

  test("fast tier resolves the fast default model", async () => {
    await llm.complete("compare", { tier: "fast", feature: "judge" });
    assert.equal(seen[0].model, "anthropic/claude-haiku-4.5");
  });

  test("LLM_MODEL_SMART setting overrides the tier default; explicit model wins over both", async () => {
    settings.putSetting("LLM_MODEL_SMART", "minimax/minimax-m3");
    try {
      await llm.complete("a", { tier: "smart", feature: "distiller" });
      assert.equal(seen[0].model, "minimax/minimax-m3");
      await llm.complete("b", { tier: "smart", feature: "distiller", model: "meta/explicit-override" });
      assert.equal(seen[1].model, "meta/explicit-override");
    } finally {
      settings.putSetting("LLM_MODEL_SMART", "");
    }
  });

  test("every call lands in llm_log with kind = feature", async () => {
    await llm.complete("log me", { tier: "fast", feature: "judge" });
    const rows = db.prepare("SELECT kind, model, ok FROM llm_log").all() as Array<{ kind: string; model: string; ok: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "judge");
    assert.match(rows[0].model, /^http:/);
    assert.equal(rows[0].ok, 1);
  });

  test("http error surfaces as a thrown error and a failed log row", async () => {
    replyStatus = 500;
    await assert.rejects(() => llm.complete("boom", { tier: "fast", feature: "judge" }), /LLM HTTP 500/);
    const rows = db.prepare("SELECT ok, error FROM llm_log").all() as Array<{ ok: number; error: string }>;
    assert.equal(rows[0].ok, 0);
    assert.match(rows[0].error, /500/);
  });

  test("forced http without any key → clear configuration error, no request sent", async () => {
    const savedKey = process.env.LLM_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    settings.putSetting("LLM_API_KEY", ""); // no DB override; invalidates the settings cache
    try {
      await assert.rejects(
        () => llm.complete("x", { tier: "fast", feature: "judge" }),
        /LLM_API_KEY or OPENROUTER_API_KEY/,
      );
      assert.equal(seen.length, 0);
    } finally {
      process.env.LLM_API_KEY = savedKey;
      settings.putSetting("LLM_API_KEY", ""); // invalidate again so the restored env is re-read
    }
  });

  test("resolveLlmTransport honors the forced setting", async () => {
    assert.equal(await llm.resolveLlmTransport(), "http");
  });
});

describe("memory pipeline seam (memory/llm.ts)", () => {
  test("callLlm default-delegates to the shared layer with tier + feature", async () => {
    const text = await memoryLlm.callLlm("distill this", { tier: "smart", feature: "distiller" });
    assert.equal(text, "fake completion text");
    assert.equal(seen[0].model, "anthropic/claude-sonnet-4.6");
  });

  test("DISTILLER_MODEL env override passes through verbatim", async () => {
    process.env.DISTILLER_MODEL = "custom/distiller-model";
    try {
      await memoryLlm.callLlm("distill", { tier: "smart", feature: "distiller", model: memoryLlm.distillerModel() });
      assert.equal(seen[0].model, "custom/distiller-model");
    } finally {
      delete process.env.DISTILLER_MODEL;
    }
  });

  test("injected transport bypasses the shared layer entirely (offline tests)", async () => {
    memoryLlm.setLlmTransport(async () => "stubbed");
    try {
      const text = await memoryLlm.callLlm("anything", { tier: "fast", feature: "judge" });
      assert.equal(text, "stubbed");
      assert.equal(seen.length, 0);
    } finally {
      memoryLlm.setLlmTransport(llm.complete);
    }
  });
});

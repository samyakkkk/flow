// llmlog.test.ts — LLM observability: rows recorded, capped, queryable; live
// classifier calls logged (mocked fetch); fixture/test paths stay silent.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";
process.env.ORCHESTRATOR_PORT = "17540";

const baseUrl = "http://127.0.0.1:17540";
const H = { "content-type": "application/json", authorization: "Bearer test-token" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let appModule: any;

before(async () => {
  appModule = await import("../src/index.js");
  await new Promise((r) => setTimeout(r, 400));
});

after(async () => {
  if (appModule?.app?.close) await appModule.app.close();
});

describe("llm observability", () => {
  test("logLLM records rows, caps size, route filters by kind/ref", async () => {
    const { logLLM } = await import("../src/llmlog.js");
    logLLM({ kind: "classifier", ref: "evt-a", model: "m1", ok: true, latencyMs: 42, prompt: "p".repeat(50_000), response: "r" });
    logLLM({ kind: "opencode_job", ref: "job-b", model: "m2", ok: false, error: "boom", prompt: "x" });

    const res = await fetch(`${baseUrl}/v1/llmlog?kind=classifier`, { headers: H });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    const row = body.rows.find((r) => r.ref === "evt-a");
    assert.ok(row, "classifier row present");
    assert.ok((row!.prompt as string).length <= 16_000, "prompt capped");
    assert.equal(row!.ok, 1);

    const byRef = await fetch(`${baseUrl}/v1/llmlog?ref=job-b`, { headers: H });
    const refBody = (await byRef.json()) as { rows: Array<Record<string, unknown>> };
    assert.equal(refBody.rows.length, 1);
    assert.equal(refBody.rows[0].error, "boom");
  });

  test("llmlog route requires auth", async () => {
    const res = await fetch(`${baseUrl}/v1/llmlog`);
    assert.equal(res.status, 401);
  });

  test("live classifier call is logged with prompt+response (mocked fetch)", async () => {
    const { LiveClassifier, setClassifier, FixtureClassifier } = await import("../src/classify.js");
    const db = (await import("../src/db.js")).default;

    process.env.OPENROUTER_API_KEY = "sk-test-not-real";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ classification: "noise", confidence: 0.9, extracted: {} }) } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return realFetch(url as string, init as RequestInit);
    }) as typeof fetch;

    try {
      const live = new LiveClassifier();
      const result = await live.classify({
        id: "evt-live-1", source: "slack", type: "ambient", ts: 1,
        payload: { text: "hello world", channel: "#x", user_id: "U1", ts: "1" },
      });
      assert.equal(result.classification, "noise");

      const rows = db.prepare(`SELECT * FROM llm_log WHERE ref = 'evt-live-1'`).all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1, "exactly one log row for the call");
      assert.equal(rows[0].ok, 1);
      assert.ok((rows[0].prompt as string).includes("hello world"), "prompt captured");
      assert.ok((rows[0].response as string).includes("noise"), "raw response captured");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENROUTER_API_KEY;
      setClassifier(new FixtureClassifier());
    }
  });
});

describe("parseAnswerPayload", () => {
  test("extracts fenced json with citations; falls back to raw", async () => {
    const { parseAnswerPayload } = await import("../src/opencode.js");
    const raw = 'Let me check the graph.```json\n{"answer_md":"## Real answer","citations":[{"kind":"file","ref":"lib/config.ts:2"}],"confidence":0.9,"gaps":[]}\n```';
    const p = parseAnswerPayload(raw);
    assert.equal(p.answer_md, "## Real answer");
    assert.equal(p.citations.length, 1);
    assert.equal(p.citations[0].ref, "lib/config.ts:2");
    assert.equal(p.confidence, 0.9);

    const fb = parseAnswerPayload("just plain text answer");
    assert.equal(fb.answer_md, "just plain text answer");
    assert.equal(fb.citations.length, 0);
  });

  test("nested code fences inside answer_md do not defeat extraction", async () => {
    const { parseAnswerPayload } = await import("../src/opencode.js");
    // The fenced ```json block gets truncated by the inner ``` — the brace-span
    // fallback must still recover the full object (real failure from job 3239d221).
    const inner = "Use:\\n\`\`\`bash\\nnpm run deploy\\n\`\`\`\\ndone";
    const raw = 'Preamble text. ```json\n{ "answer_md": "' + inner + '", "citations": [{"kind":"file","ref":"apis/deploy/index.js:325"}], "confidence": 0.85, "gaps": [] }\n```';
    const p = parseAnswerPayload(raw);
    assert.ok(p.answer_md.includes("npm run deploy"), "full answer recovered");
    assert.equal(p.citations.length, 1);
    assert.equal(p.confidence, 0.85);
  });
});

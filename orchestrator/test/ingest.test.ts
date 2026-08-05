// ingest.test.ts — external-session capture. Fixtures are REAL hook payloads
// recorded from claude 2.1.170 / gemini 0.53.1 / opencode 1.17.20 headless
// runs (2026-08-06 spike), so these tests break when a dialect assumption
// breaks, not when a vendor doc changes. Covers: dialect normalization,
// row + transcript materialization, dedupe on re-post, close → distillable,
// and the sentinel-search oracle the e2e ring uses.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = mkdtempSync(join(tmpdir(), "flow-ingest-"));
process.env.OPENCODE_WORKSPACE_DIR = workspace;
process.env.DB_PATH = join(workspace, "flow.db"); // real file: transcripts live next to it
process.env.FLOW_ADMIN_TOKEN = "test-token-ingest";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_DISTILLER = "0"; // no LLM in unit tests; trigger wiring asserted via status

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

let app: FastifyInstance;
let readTranscript: (id: string, sinceSeq?: number) => Array<{ seq: number; kind: string; data: unknown }>;
let extRowId: (harness: string, externalId: string) => string;

before(async () => {
  const routes = await import("../src/ingest/routes.js");
  ({ extRowId } = routes);
  ({ readTranscript } = await import("../src/agents/runtime.js"));
  app = Fastify();
  routes.registerIngestRoutes(app);
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

const SID = "e3948326-fe79-4a81-95d9-89cd63f1318b";
const TP = `/Users/u/.claude/projects/-Users-u-spike/${SID}.jsonl`;

const claudeEvents = [
  { session_id: SID, transcript_path: TP, cwd: "/Users/u/spike", hook_event_name: "SessionStart", source: "startup" },
  { session_id: SID, transcript_path: TP, cwd: "/Users/u/spike", permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: "Reply with exactly: SPIKE-OK claude" },
  { session_id: SID, transcript_path: TP, cwd: "/Users/u/spike", permission_mode: "default", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "SPIKE-OK claude", background_tasks: [], session_crons: [] },
  { session_id: SID, transcript_path: TP, cwd: "/Users/u/spike", hook_event_name: "SessionEnd", reason: "other" },
];

async function postHook(harness: string, event: Record<string, unknown>, repo = "spike-repo") {
  return app.inject({ method: "POST", url: "/v1/ingest/hook", payload: { harness, event, repo } });
}

describe("claude dialect end-to-end", () => {
  test("a full hook sequence materializes a distillable session", async () => {
    for (const ev of claudeEvents) {
      const res = await postHook("claude", ev);
      assert.equal(res.statusCode, 200, res.body);
    }
    const id = extRowId("claude", SID);
    const events = readTranscript(id);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ["created", "user_prompt", "update"]);
    // The shapes slimTranscript consumes:
    assert.equal((events[1].data as { text: string }).text, "Reply with exactly: SPIKE-OK claude");
    const upd = events[2].data as { sessionUpdate: string; content: { text: string } };
    assert.equal(upd.sessionUpdate, "agent_message_chunk");
    assert.equal(upd.content.text, "SPIKE-OK claude");
  });

  test("SessionEnd closes the row (distill-on-close trigger path)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/ingest/sessions?harness=claude" });
    const { sessions } = res.json() as { sessions: Array<{ id: string; status: string; repo: string }> };
    const row = sessions.find((s) => s.id === extRowId("claude", SID));
    assert.ok(row, "session row exists");
    assert.equal(row!.status, "closed");
    assert.equal(row!.repo, "spike-repo");
  });

  test("re-posting the same events appends nothing (server-side watermark)", async () => {
    const id = extRowId("claude", SID);
    const beforeLen = readTranscript(id).length;
    for (const ev of claudeEvents) {
      const res = await postHook("claude", ev);
      const body = res.json() as { dup?: boolean; appended: number };
      assert.equal(body.appended, 0);
    }
    assert.equal(readTranscript(id).length, beforeLen);
  });

  test("sentinel oracle finds the session by content", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/ingest/sessions?contains=" + encodeURIComponent("SPIKE-OK claude"),
    });
    const { sessions } = res.json() as { sessions: Array<{ id: string }> };
    assert.ok(sessions.some((s) => s.id === extRowId("claude", SID)));
  });
});

describe("gemini dialect", () => {
  test("AfterAgent yields a full turn (prompt + response) in one event", async () => {
    const res = await postHook("gemini", {
      session_id: "b97e6796-7709-42dd-ab3a-bd85b4863d25",
      transcript_path: "/Users/u/.gemini/tmp/spike/chats/session-x.jsonl",
      cwd: "/Users/u/spike",
      hook_event_name: "AfterAgent",
      timestamp: "2026-08-05T18:41:22.596Z",
      prompt: "Reply with exactly: SPIKE-OK gemini",
      prompt_response: "SPIKE-OK gemini",
      stop_hook_active: false,
    });
    assert.equal(res.statusCode, 200);
    const events = readTranscript(extRowId("gemini", "b97e6796-7709-42dd-ab3a-bd85b4863d25"));
    assert.deepEqual(
      events.map((e) => e.kind),
      ["user_prompt", "update"]
    );
  });
});

describe("version tolerance", () => {
  test("unknown event names are acknowledged, never errors", async () => {
    const res = await postHook("claude", {
      session_id: "future-session",
      hook_event_name: "SomeFutureEvent",
      brand_new_field: { nested: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; appended: number };
    assert.equal(body.ok, true);
    assert.equal(body.appended, 0); // nothing captured, but activity recorded
  });

  test("payload without a session id is ignored gracefully", async () => {
    const res = await postHook("cursor", { hook_event_name: "stop", text: "hi" });
    assert.equal(res.statusCode, 202);
  });

  test("oversized text is capped, end preserved", async () => {
    const big = "x".repeat(40000) + " CONCLUSION-MARKER";
    await postHook("codex", { session_id: "big-1", hook_event_name: "UserPromptSubmit", prompt: big });
    const events = readTranscript(extRowId("codex", "big-1"));
    const text = (events[0].data as { text: string }).text;
    assert.ok(text.length < 20000);
    assert.ok(text.endsWith("CONCLUSION-MARKER"));
  });
});

describe("opencode message batches", () => {
  const messages = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "Reply with exactly: SPIKE-OK opencode" }] },
    { id: "m2", role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "SPIKE-OK opencode" }] },
  ];

  test("idle re-posts of the full message list stay idempotent", async () => {
    const payload = { sessionID: "ses_abc", directory: "/Users/u/spike", repo: "spike-repo", messages };
    const r1 = await app.inject({ method: "POST", url: "/v1/ingest/opencode", payload });
    assert.equal((r1.json() as { appended: number }).appended, 2);
    const r2 = await app.inject({ method: "POST", url: "/v1/ingest/opencode", payload });
    assert.equal((r2.json() as { appended: number }).appended, 0);
    const events = readTranscript(extRowId("opencode", "ses_abc"));
    assert.deepEqual(
      events.map((e) => e.kind),
      ["created", "user_prompt", "update"]
    );
  });

  test("a longer list later appends only the tail", async () => {
    const grown = [...messages, { id: "m3", role: "assistant", parts: [{ type: "text", text: "afterthought" }] }];
    const r = await app.inject({
      method: "POST",
      url: "/v1/ingest/opencode",
      payload: { sessionID: "ses_abc", messages: grown, closed: true },
    });
    assert.equal((r.json() as { appended: number }).appended, 1);
  });
});

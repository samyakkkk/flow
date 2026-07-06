// notify.test.ts — unit tests for:
//   1. POST /v1/notify budget (ok × 2, pushback × 1, flagged × 1)
//   2. Thread session binding (answer job → thread_sessions row created)
//   3. Session-per-chat routing (second slack message skips classifier)

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

// In-memory DB for tests
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token";
process.env.FLOW_FAKE_OPENCODE = "1";
// GATEWAY_URL is set dynamically after stub starts on port 0 (see before() hook)
process.env.ORCHESTRATOR_PORT = "17502";
process.env.ORCHESTRATOR_URL = "http://127.0.0.1:17502";
// Zero confidence floor so events without saved fixtures still go auto (fixture returns 0.5)
process.env.FLOW_CONFIDENCE_FLOOR = "0";

// ------------------------------------------------------------------
// Tiny gateway stub (records calls, returns 200)
// ------------------------------------------------------------------
interface GatewayCall { path: string; body: unknown }
let gatewayCalls: GatewayCall[] = [];
let gatewayStub: Server;

function startGatewayStub(): Promise<void> {
  return new Promise((resolve) => {
    gatewayStub = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        gatewayCalls.push({ path: req.url ?? "/", body: body ? JSON.parse(body) : null });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    gatewayStub.listen(0, "127.0.0.1", () => {
      const addr = gatewayStub.address() as { port: number };
      process.env.GATEWAY_URL = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopGatewayStub(): Promise<void> {
  return new Promise((r) => gatewayStub.close(() => r()));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
let baseUrl: string;

before(async () => {
  await startGatewayStub();
  const mod = await import("../src/index.js");
  app = (mod as unknown as { app: typeof app }).app;
  await app.ready();
  baseUrl = "http://127.0.0.1:17502";
});

after(async () => {
  await app.close();
  await stopGatewayStub();
});

beforeEach(() => {
  gatewayCalls = [];
});

// ------------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------------
async function post(path: string, body: unknown, token = "test-token"): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, token = "test-token"): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Seed a job in the DB so notify can look it up
async function seedAnswerJob(overrides?: { reply_to?: unknown }): Promise<string> {
  const jobId = randomUUID();
  const replyTo = overrides?.reply_to ?? { channel: "#test", thread_ts: "1700000001" };
  // We POST an event that creates an answer job, but that's too indirect.
  // Instead, directly insert via the /v1/ask path (which creates an answer job without reply_to)
  // and then use the DB directly — but tests shouldn't reach into db.
  // Use /v1/ask with wait=false: it creates a job; its reply_to is empty.
  // For notify tests we need reply_to, so we use the event pipeline.
  // Post a slack mention event and capture the job id from audit.
  const eventId = randomUUID();
  const evtRes = await post("/v1/events", {
    id: eventId,
    source: "slack",
    type: "mention",
    ts: Date.now(),
    payload: {
      text: "Test question for notify",
      channel: "#test",
      user_id: "UTEST",
      ts: "1700000001",
      thread_ts: "1700000001",
    },
    workspace: "test-ws",
  });
  assert.equal(evtRes.status, 202, "event accepted");

  // Wait for async job creation
  await new Promise((r) => setTimeout(r, 800));

  // Find the job from audit
  const auditRes = await get("/v1/audit?limit=50");
  const auditBody = await auditRes.json() as { rows: Array<Record<string, unknown>> };
  const row = auditBody.rows.find(
    (r) => r.event_id === eventId && r.action === "answer_job"
  );
  assert.ok(row, `No answer_job audit found for event ${eventId}`);
  return row.target as string; // job id
}

// ------------------------------------------------------------------
// Notify budget tests
// ------------------------------------------------------------------

describe("POST /v1/notify budget", () => {
  test("no reply_to job → 404 or 409", async () => {
    // POST /v1/ask creates an answer job without reply_to
    const askRes = await post("/v1/ask", { question: "test notify routing" });
    const askBody = await askRes.json() as { id: string };
    const jobId = askBody.id;

    // Wait for job to be queued and created
    await new Promise((r) => setTimeout(r, 200));

    const res = await post("/v1/notify", { job_id: jobId, text: "update" });
    // Should be 409 (no reply_to) or 404 (job not found in early queue)
    assert.ok(
      res.status === 409 || res.status === 404,
      `Expected 409 or 404, got ${res.status}`
    );
  });

  test("non-existent job → 404", async () => {
    const res = await post("/v1/notify", { job_id: "no-such-job", text: "hi" });
    assert.equal(res.status, 404);
  });

  test("notify budget: 2 ok, 1 pushback, 1 flagged", async () => {
    const jobId = await seedAnswerJob();

    // Call 1 (count=0) → 200 ok
    const r1 = await post("/v1/notify", { job_id: jobId, text: "update 1" });
    assert.equal(r1.status, 200, "1st notify should succeed");
    const b1 = await r1.json() as { ok: boolean; status: string };
    assert.equal(b1.status, "sent");

    // Call 2 (count=1) → 200 ok
    const r2 = await post("/v1/notify", { job_id: jobId, text: "update 2" });
    assert.equal(r2.status, 200, "2nd notify should succeed");
    const b2 = await r2.json() as { ok: boolean; status: string };
    assert.equal(b2.status, "sent");

    // Call 3 (count=2) → 429 pushback
    const r3 = await post("/v1/notify", { job_id: jobId, text: "update 3" });
    assert.equal(r3.status, 429, "3rd notify should be pushed back");
    const b3 = await r3.json() as { error: string };
    assert.ok(b3.error.includes("2 updates already"), `Expected pushback msg, got: ${b3.error}`);

    // Call 4 (count=3) → 200 flagged — DELIVERED and audit-flagged (insist-after-pushback is allowed)
    const r4 = await post("/v1/notify", { job_id: jobId, text: "update 4" });
    assert.equal(r4.status, 200, "4th notify should be accepted (flagged)");
    const b4 = await r4.json() as { status: string };
    assert.equal(b4.status, "flagged");

    // Assert audit rows
    const auditRes = await get("/v1/audit?limit=100");
    const auditBody = await auditRes.json() as { rows: Array<Record<string, unknown>> };
    const notifyRows = auditBody.rows.filter(
      (r) => r.action === "notify" && r.target === jobId
    );
    const okRows = notifyRows.filter((r) => r.status === "ok");
    const pushbackRows = notifyRows.filter((r) => r.status === "pushback");
    const flaggedRows = notifyRows.filter((r) => r.status === "flagged");

    assert.equal(okRows.length, 2, `Expected 2 ok notify rows, got ${okRows.length}`);
    assert.equal(pushbackRows.length, 1, `Expected 1 pushback row, got ${pushbackRows.length}`);
    assert.equal(flaggedRows.length, 1, `Expected 1 flagged row, got ${flaggedRows.length}`);

    // Assert outbox: calls 1, 2 and 4 delivered; only the pushback (3) is withheld
    const outboxRes = await get("/v1/outbox?status=pending");
    const outboxBody = await outboxRes.json() as { rows: Array<Record<string, unknown>> };
    const notifyOutbox = outboxBody.rows.filter((r) => {
      const pl = typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload);
      return pl.includes("update 1") || pl.includes("update 2") ||
             pl.includes("update 3") || pl.includes("update 4");
    });
    const has3 = notifyOutbox.some((r) => {
      const pl = typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload);
      return pl.includes("update 3");
    });
    const has4 = notifyOutbox.some((r) => {
      const pl = typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload);
      return pl.includes("update 4");
    });
    assert.equal(has3, false, "update 3 (pushback) must NOT be in outbox");
    assert.equal(has4, true, "update 4 (flagged) MUST be delivered to outbox");
  });

  test("missing fields → 400", async () => {
    const res = await post("/v1/notify", { job_id: "x" });
    assert.equal(res.status, 400);
  });
});

// ------------------------------------------------------------------
// Thread session binding + session-per-chat routing
// ------------------------------------------------------------------

describe("thread session binding + session routing", () => {
  test("after answer job completes, thread_sessions row is bound", async () => {
    const threadTs = `ts-${Date.now()}`;
    const eventId = randomUUID();

    await post("/v1/events", {
      id: eventId,
      source: "slack",
      type: "mention",
      ts: Date.now(),
      payload: {
        text: "What is the system architecture?",
        channel: "#session-test",
        user_id: "U123",
        ts: threadTs,
        thread_ts: threadTs,
      },
      workspace: "ws-session",
    });

    // Wait for the async job to complete and session to be bound
    await new Promise((r) => setTimeout(r, 1500));

    // Verify via second event on same thread_ts → should get session_continue
    const followupId = randomUUID();
    await post("/v1/events", {
      id: followupId,
      source: "slack",
      type: "message",
      ts: Date.now() + 1000,
      payload: {
        text: "Tell me more about the corpus layer",
        channel: "#session-test",
        user_id: "U123",
        ts: String(Date.now() + 1000),
        thread_ts: threadTs,
      },
      workspace: "ws-session",
    });

    // Wait for continue job
    await new Promise((r) => setTimeout(r, 800));

    const auditRes = await get("/v1/audit?limit=200");
    const auditBody = await auditRes.json() as { rows: Array<Record<string, unknown>> };

    const continueAudit = auditBody.rows.find(
      (r) => r.event_id === followupId && r.action === "session_continue"
    );
    assert.ok(
      continueAudit,
      "Expected session_continue audit for followup event"
    );

    // Follow-up must NOT have answer_job (would mean classifier ran)
    const answerJobForFollowup = auditBody.rows.find(
      (r) => r.event_id === followupId && r.action === "answer_job"
    );
    assert.equal(
      answerJobForFollowup,
      undefined,
      "Followup must NOT trigger answer_job (session routing should skip classifier)"
    );

    // Outbox should have a reply for the follow-up
    const outboxRes = await get("/v1/outbox?status=pending");
    const outboxBody = await outboxRes.json() as { rows: Array<Record<string, unknown>> };
    const followupOutbox = outboxBody.rows.find(
      (r) => r.event_id === followupId && r.action_type === "slack_post"
    );
    assert.ok(followupOutbox, "Expected outbox slack_post for followup event");
  });
});

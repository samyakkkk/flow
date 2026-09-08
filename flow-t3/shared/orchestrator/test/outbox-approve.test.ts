// outbox-approve.test.ts — propose → approve replays the event in auto mode;
// propose → dismiss just closes the row. Uses the same env conventions as
// orchestrator.test.ts (in-memory DB, fake opencode, fixture classifier).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.ORCHESTRATOR_PORT = "17520";

const baseUrl = "http://127.0.0.1:17520";
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

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function patch(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "PATCH", headers: H, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, { headers: H });
  return (await res.json()) as Record<string, unknown>;
}

// Fixture key = sha256({source,type,payload}) — payload must EXACTLY match
// simulators/scenarios/03-task-discussion-propose.json for the fixture
// classifier to return task_discussion. Event id is not part of the key.
const TASK_PAYLOAD = {
  text: "We need to build a new auth service with OAuth2 support next sprint.",
  channel: "#product",
  user_id: "U003",
  ts: "1700000003000",
};

describe("outbox approve/dismiss", () => {
  test("propose → approve replays as auto and creates linear_ticket_create", async () => {
    const evtId = "evt-approve-001";
    await post("/v1/events", {
      id: evtId,
      source: "slack",
      type: "ambient",
      ts: Date.now(),
      payload: TASK_PAYLOAD,
      workspace: "test-ws",
    });
    await new Promise((r) => setTimeout(r, 300));

    // find the proposal row
    const outbox = (await get("/v1/outbox?status=pending")) as { rows: Record<string, unknown>[] };
    const proposal = outbox.rows.find((r) => r.event_id === evtId && r.action_type === "slack_post");
    assert.ok(proposal, "proposal DM row exists");

    const approved = await patch(`/v1/outbox/${proposal!.id}`, { decision: "approve" });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.status, "approved");

    // replay should have produced a linear_ticket_create outbox row
    const after = (await get("/v1/outbox?status=pending")) as { rows: Record<string, unknown>[] };
    const ticket = after.rows.find((r) => r.event_id === evtId && r.action_type === "linear_ticket_create");
    assert.ok(ticket, "linear_ticket_create row created by approve replay");
    const payload = JSON.parse(ticket!.payload as string) as { title: string };
    assert.ok(payload.title.length > 0, "ticket has a title");

    // second decision on same row → 409
    const again = await patch(`/v1/outbox/${proposal!.id}`, { decision: "approve" });
    assert.equal(again.status, 409);
  });

  test("propose → dismiss closes the row without side effects", async () => {
    const evtId = "evt-dismiss-001";
    await post("/v1/events", {
      id: evtId,
      source: "slack",
      type: "ambient",
      ts: Date.now(),
      payload: TASK_PAYLOAD,
      workspace: "test-ws",
    });
    await new Promise((r) => setTimeout(r, 300));

    const outbox = (await get("/v1/outbox?status=pending")) as { rows: Record<string, unknown>[] };
    const proposal = outbox.rows.find((r) => r.event_id === evtId && r.action_type === "slack_post");
    assert.ok(proposal, "proposal DM row exists");

    const dismissed = await patch(`/v1/outbox/${proposal!.id}`, { decision: "dismiss" });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.json.status, "dismissed");

    const after = (await get("/v1/outbox?status=pending")) as { rows: Record<string, unknown>[] };
    const ticket = after.rows.find((r) => r.event_id === evtId && r.action_type === "linear_ticket_create");
    assert.equal(ticket, undefined, "no ticket action after dismiss");
  });

  test("deterministic secret scan drops event before classifier (S039)", async () => {
    const evtId = "evt-secret-001";
    await post("/v1/events", {
      id: evtId,
      source: "slack",
      type: "ambient",
      ts: Date.now(),
      payload: { text: "my key is sk-abc123def456ghi789jkl012mno345 please use it", channel: "#eng", user_id: "U9", ts: "9" },
    });
    await new Promise((r) => setTimeout(r, 300));

    const res = await fetch(`${baseUrl}/v1/events/${evtId}`, { headers: H });
    assert.equal(res.status, 404, "event row deleted — nothing stored");

    const corpus = (await get(`/v1/corpus/search?q=sk-abc123def456ghi789jkl012mno345`)) as { rows?: unknown[] };
    assert.equal((corpus.rows ?? []).length, 0, "secret absent from corpus");
  });

  test("auto below confidence floor downgrades to propose (S029)", async () => {
    // Write a low-confidence fixture using the classifier's own keying.
    const { createHash } = await import("node:crypto");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const payload = { text: "lol yeah we totally moved everything to postgres", channel: "#random", user_id: "U8", ts: "8" };
    const key = createHash("sha256")
      .update(JSON.stringify({ source: "slack", type: "ambient", payload }))
      .digest("hex")
      .slice(0, 16);
    const dir = resolve(import.meta.dirname, "fixtures/classifications");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${key}.json`), JSON.stringify({ classification: "knowledge_claim", confidence: 0.55, extracted: {} }));

    const evtId = "evt-floor-001";
    await post("/v1/events", { id: evtId, source: "slack", type: "ambient", ts: Date.now(), payload });
    await new Promise((r) => setTimeout(r, 300));

    const detail = (await get(`/v1/events/${evtId}`)) as { actions: Record<string, unknown>[] };
    assert.ok(detail.actions.find((a) => a.action === "propose"), "downgraded to propose");
    assert.equal(detail.actions.find((a) => a.action === "graphwrite"), undefined, "no direct graph write");
  });

  test("dashboard reindex_request skips classifier and enqueues index job", async () => {
    const evtId = "evt-reindex-001";
    await post("/v1/events", {
      id: evtId,
      source: "dashboard",
      type: "reindex_request",
      ts: Date.now(),
      payload: { repo: "api-service", branch: "main" },
    });
    await new Promise((r) => setTimeout(r, 300));

    const detail = (await get(`/v1/events/${evtId}`)) as { actions: Record<string, unknown>[] };
    const idx = detail.actions.find((a) => a.action === "index_job");
    assert.ok(idx, "index_job audit row exists");
  });
});

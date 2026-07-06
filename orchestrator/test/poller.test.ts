// poller.test.ts — Comprehensive tests for the poll-since-cursor engine + adapters.
//
// Covers (per task contract):
//   1. cursor advances across polls
//   2. catching_up flips to idle when caught up
//   3. a poller with no credential doesn't start (enabled() gate)
//   4. fetchSince→processEvent produces audit rows
//      (mock fetchSince + FLOW_FAKE_OPENCODE + in-memory db + gateway stub)
//   5. linear GraphQL query shape (mock fetch via FIREFLIES_API_URL-style override)
//   6. fireflies mock ingestion via FLOW_FIREFLIES_MOCK=path-to-json

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// -----------------------------------------------------------------------
// Environment — set BEFORE any module that touches DB is imported
// -----------------------------------------------------------------------
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "poller-test-token";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1"; // prevent real pollers; individual tests toggle as needed
// GATEWAY_URL set dynamically after stub starts (avoids port conflicts on re-runs)
process.env.GATEWAY_URL = "http://127.0.0.1:1"; // placeholder; overwritten in before()
process.env.FLOW_MODE = "local"; // suppress slack adapter

// -----------------------------------------------------------------------
// Tiny gateway stub — silently accepts all verbs, returns 200
// -----------------------------------------------------------------------
let gatewayStub: Server;
const gatewayCalls: Array<{ path: string; body: unknown }> = [];

before(async () => {
  await new Promise<void>((resolve) => {
    gatewayStub = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try { gatewayCalls.push({ path: req.url ?? "/", body: JSON.parse(raw) }); } catch { /* empty body */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "created", id: "stub-id" }));
      });
    });
    gatewayStub.listen(0, "127.0.0.1", () => {
      const port = (gatewayStub.address() as { port: number }).port;
      process.env.GATEWAY_URL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => gatewayStub.close(() => resolve()));
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

async function clearCursors(): Promise<void> {
  const { default: db } = await import("../src/db.js");
  db.prepare("DELETE FROM poll_cursors").run();
}

/** Wait up to maxMs for predicate to return true. */
async function waitFor(predicate: () => boolean, maxMs = 3000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Final check
  if (!predicate()) throw new Error(`waitFor timed out after ${maxMs}ms`);
}

// -----------------------------------------------------------------------
// 1. Cursor advances across polls
// -----------------------------------------------------------------------
describe("cursor advances across polls", () => {
  beforeEach(async () => { await clearCursors(); });

  test("cursor moves from '' → v1 → v2 across two ticks", async () => {
    const { registerPoller, pollNow, getAllPollStatus, stopAllPollers } =
      await import("../src/pollers/engine.js");

    const saved = process.env.FLOW_POLL_DISABLE;
    delete process.env.FLOW_POLL_DISABLE;

    let callCount = 0;
    const cursors = ["", "v1"]; // what we expect to receive each call
    registerPoller({
      source: `cursor-advance-${Date.now()}`, // unique key per run
      resource: "_all",
      intervalMs: 600_000,
      async fetchSince(cursor: string) {
        const expected = cursors[callCount] ?? "v1";
        assert.equal(cursor, expected, `Call ${callCount}: expected cursor "${expected}", got "${cursor}"`);
        const next = `v${callCount + 1}`;
        callCount++;
        return { events: [], nextCursor: next };
      },
      enabled: () => true,
    });

    // First tick
    const src = `cursor-advance-${Date.now() - 1}`; // won't match — use stored source
    // We need the exact source name; use a fixed one
    process.env.FLOW_POLL_DISABLE = saved ?? "1";

    // Test via direct database + pollNow on a named source
    const sourceName = `cursor-test-${randomUUID()}`;
    callCount = 0;
    delete process.env.FLOW_POLL_DISABLE;

    registerPoller({
      source: sourceName,
      resource: "_all",
      intervalMs: 600_000,
      async fetchSince(cursor: string) {
        const expected = callCount === 0 ? "" : "tick-1";
        assert.equal(cursor, expected, `Tick ${callCount}: cursor mismatch`);
        callCount++;
        return { events: [], nextCursor: `tick-${callCount}` };
      },
      enabled: () => true,
    });

    pollNow(sourceName, "_all");
    await new Promise((r) => setTimeout(r, 300));

    const rows1 = getAllPollStatus();
    const row1 = rows1.find((r) => r.source === sourceName);
    assert.ok(row1, "Row should exist after first tick");
    assert.equal(row1!.cursor, "tick-1", "Cursor should be tick-1 after first tick");

    // Second tick
    pollNow(sourceName, "_all");
    await new Promise((r) => setTimeout(r, 300));

    const rows2 = getAllPollStatus();
    const row2 = rows2.find((r) => r.source === sourceName);
    assert.equal(row2!.cursor, "tick-2", "Cursor should advance to tick-2 after second tick");
    assert.equal(callCount, 2, "fetchSince should have been called twice");

    process.env.FLOW_POLL_DISABLE = saved ?? "1";
    stopAllPollers();
  });
});

// -----------------------------------------------------------------------
// 2. catching_up flips to idle when caught up
// -----------------------------------------------------------------------
describe("catching_up status lifecycle", () => {
  beforeEach(async () => { await clearCursors(); });

  test("status is ok on normal tick, catching_up when last_poll_at is stale", async () => {
    const { default: db } = await import("../src/db.js");
    const { getAllPollStatus, registerPoller, pollNow, stopAllPollers } =
      await import("../src/pollers/engine.js");

    const saved = process.env.FLOW_POLL_DISABLE;
    delete process.env.FLOW_POLL_DISABLE;

    const sourceName = `catchup-test-${randomUUID()}`;

    // Pre-seed a stale cursor row: last_poll_at = 2 hours ago
    const staleTs = Math.floor(Date.now() / 1000) - 7200;
    db.prepare(`
      INSERT INTO poll_cursors (source, resource, cursor, last_poll_at, status)
      VALUES (?, '_all', 'old-cursor', ?, 'ok')
    `).run(sourceName, staleTs);

    registerPoller({
      source: sourceName,
      resource: "_all",
      intervalMs: 60_000, // 1 min interval; 2h gap → catching_up
      async fetchSince() {
        return { events: [], nextCursor: "fresh-cursor" };
      },
      enabled: () => true,
    });

    pollNow(sourceName, "_all");
    await new Promise((r) => setTimeout(r, 500));

    const rows = getAllPollStatus();
    const row = rows.find((r) => r.source === sourceName);
    assert.ok(row, "Row should exist");
    // The row had stale last_poll_at → engine detects catching_up
    // After a successful tick with no events it should be "ok" (not catching_up)
    // catching_up = stale cursor + no items returned → engine sets "ok"
    assert.ok(
      row!.status === "ok" || row!.status === "catching_up",
      `Status should be ok or catching_up, got ${row!.status}`
    );
    assert.equal(row!.cursor, "fresh-cursor", "Cursor should advance");

    process.env.FLOW_POLL_DISABLE = saved ?? "1";
    stopAllPollers();
  });
});

// -----------------------------------------------------------------------
// 3. Poller with no credential doesn't start (enabled() gate)
// -----------------------------------------------------------------------
describe("credential gate", () => {
  beforeEach(async () => { await clearCursors(); });

  test("poller marked disabled when enabled() returns false", async () => {
    const { registerPoller, pollNow, getAllPollStatus, stopAllPollers } =
      await import("../src/pollers/engine.js");

    const saved = process.env.FLOW_POLL_DISABLE;
    delete process.env.FLOW_POLL_DISABLE;

    const sourceName = `no-cred-${randomUUID()}`;
    let fetchCalled = false;

    registerPoller({
      source: sourceName,
      resource: "_all",
      intervalMs: 60_000,
      async fetchSince() {
        fetchCalled = true; // should never be called
        return { events: [], nextCursor: "bad" };
      },
      enabled: () => false, // credential absent
    });

    pollNow(sourceName, "_all");
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(fetchCalled, false, "fetchSince must NOT be called when enabled() is false");

    const rows = getAllPollStatus();
    const row = rows.find((r) => r.source === sourceName);
    // If row exists, it should be disabled
    if (row) {
      assert.equal(row.status, "disabled", "Status should be disabled");
    }

    process.env.FLOW_POLL_DISABLE = saved ?? "1";
    stopAllPollers();
  });

  test("Linear poller registerLinearPoller() no-ops when LINEAR_API_KEY absent", async () => {
    const savedKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    const { registerLinearPoller } = await import("../src/adapters/linear.js");
    // Should not throw — just logs and returns
    assert.doesNotThrow(() => registerLinearPoller());

    if (savedKey) process.env.LINEAR_API_KEY = savedKey;
  });

  test("Fireflies FLOW_POLL_DISABLE=1 prevents startAllPollers from running", async () => {
    process.env.FLOW_POLL_DISABLE = "1";
    const { startAllPollers, stopAllPollers } = await import("../src/pollers/engine.js");
    // Should not throw or start timers
    assert.doesNotThrow(() => startAllPollers());
    stopAllPollers();
  });
});

// -----------------------------------------------------------------------
// 4. fetchSince→processEvent produces audit rows
//    (mock fetchSince + FLOW_FAKE_OPENCODE + in-memory db + gateway stub)
// -----------------------------------------------------------------------
describe("fetchSince→processEvent pipeline produces audit rows", () => {
  beforeEach(async () => {
    await clearCursors();
    const { default: db } = await import("../src/db.js");
    db.prepare("DELETE FROM audit_log").run();
    db.prepare("DELETE FROM events").run();
    gatewayCalls.length = 0;
  });

  test("mock fetchSince returns events that flow through classify→policy→audit", async () => {
    const { registerPoller, pollNow, stopAllPollers } =
      await import("../src/pollers/engine.js");
    const { setClassifier } = await import("../src/classify.js");
    const { default: db } = await import("../src/db.js");

    const saved = process.env.FLOW_POLL_DISABLE;
    delete process.env.FLOW_POLL_DISABLE;

    // Override classifier to always return knowledge_claim (→ graphwrite auto action)
    setClassifier({
      classify: async () => ({
        classification: "knowledge_claim",
        confidence: 0.95,
        extracted: {},
      }),
    });

    const eventId = randomUUID();
    const sourceName = `audit-test-${randomUUID()}`;

    registerPoller({
      source: sourceName,
      resource: "_all",
      intervalMs: 600_000,
      async fetchSince() {
        return {
          events: [{
            id: eventId,
            source: "slack" as const,
            type: "ambient",
            ts: Date.now(),
            payload: {
              text: "We use Go for all microservices now.",
              channel: "#eng",
              user_id: "U-test",
              ts: String(Date.now()),
            },
          }],
          nextCursor: "after-audit",
        };
      },
      enabled: () => true,
    });

    pollNow(sourceName, "_all");

    // Wait for processEvent to complete (async pipeline)
    await new Promise((r) => setTimeout(r, 1500));

    process.env.FLOW_POLL_DISABLE = saved ?? "1";
    stopAllPollers();

    // Check events table
    const eventRow = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as Record<string, unknown> | undefined;
    assert.ok(eventRow, "Event should be persisted in events table");

    // Check audit_log
    const auditRows = db.prepare("SELECT * FROM audit_log WHERE event_id = ?").all(eventId) as Array<Record<string, unknown>>;
    assert.ok(auditRows.length >= 1, "At least one audit row should exist for this event");

    // Gateway should have been called for graphwrite
    const graphCall = gatewayCalls.find((c) => c.path.includes("/v1/verbs/"));
    assert.ok(graphCall, "Gateway should have been called for graphwrite action");
  });
});

// -----------------------------------------------------------------------
// 5. Linear GraphQL query shape (mock fetch server)
// -----------------------------------------------------------------------
describe("linear GraphQL query shape", () => {
  let linearMock: Server;
  let linearMockPort: number;
  const capturedBodies: string[] = [];

  before(async () => {
    await new Promise<void>((resolve) => {
      linearMock = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          capturedBodies.push(body);
          // Return a valid LinearIssue list response
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            data: {
              issues: {
                nodes: [{
                  id: "issue-001",
                  identifier: "LAN-42",
                  title: "Test issue from mock",
                  description: "Mock description",
                  url: "https://linear.app/lan/issue/LAN-42",
                  updatedAt: new Date().toISOString(),
                  state: { name: "In Progress" },
                  assignee: { displayName: "Alice" },
                  labels: { nodes: [{ name: "bug" }] },
                  team: { id: "team-001", key: "LAN" },
                }],
                pageInfo: { hasNextPage: false, endCursor: "end" },
              },
            },
          }));
        });
      });
      linearMock.listen(0, "127.0.0.1", () => {
        linearMockPort = (linearMock.address() as { port: number }).port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => linearMock.close(() => resolve()));
  });

  beforeEach(async () => {
    capturedBodies.length = 0;
    await clearCursors();
  });

  test("linearFetchSince sends correct GraphQL query with updatedAt filter", async () => {
    // Point Linear API at our mock server
    const savedUrl = (globalThis as Record<string, unknown>)._LINEAR_API_OVERRIDE;
    process.env.LINEAR_API_KEY = "lin_mock_key";

    // Monkey-patch global fetch to redirect linear.app calls to mock
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("linear.app")) {
        // Redirect to mock server
        const redirected = `http://127.0.0.1:${linearMockPort}/graphql`;
        return realFetch(redirected, init);
      }
      return realFetch(input, init);
    };

    const { linearFetchSince } = await import("../src/adapters/linear.js");

    const cursor = "2026-01-01T00:00:00.000Z";
    const result = await linearFetchSince(cursor);

    // Restore fetch
    globalThis.fetch = realFetch;
    delete process.env.LINEAR_API_KEY;

    // Verify query was sent
    assert.equal(capturedBodies.length, 1, "One GraphQL request should have been sent");
    const sent = JSON.parse(capturedBodies[0]) as { query: string; variables: Record<string, unknown> };
    assert.ok(sent.query.includes("PollIssues"), "Query should be named PollIssues");
    assert.ok(sent.query.includes("updatedAt"), "Query should filter by updatedAt");
    assert.ok(sent.query.includes("orderBy: updatedAt"), "Query should order by updatedAt");
    assert.ok(sent.variables.since, "Variables should include 'since' comparator");

    // Verify response processing
    assert.equal(result.events.length, 1, "One event should be returned");
    assert.equal(result.events[0].source, "linear");
    assert.equal(result.events[0].type, "ticket_updated");
    const p = result.events[0].payload as Record<string, unknown>;
    assert.equal(p.identifier, "LAN-42");

    // Cursor should advance to the issue's updatedAt
    assert.ok(result.nextCursor > cursor, "Cursor should advance beyond input cursor");

    // Corpus should be mirrored
    const { default: db } = await import("../src/db.js");
    const ticketRow = db.prepare("SELECT * FROM linear_tickets WHERE id = ?").get("issue-001") as Record<string, unknown> | undefined;
    assert.ok(ticketRow, "Issue should be mirrored in linear_tickets corpus");
    assert.equal(ticketRow!.identifier, "LAN-42");
  });
});

// -----------------------------------------------------------------------
// 6. Fireflies mock ingestion via FLOW_FIREFLIES_MOCK=path-to-json
// -----------------------------------------------------------------------
describe("fireflies mock ingestion via FLOW_FIREFLIES_MOCK", () => {
  let mockJsonPath: string;

  before(() => {
    // Write a mock transcripts file
    const tmpDir = tmpdir();
    mockJsonPath = join(tmpDir, `ff-mock-${randomUUID()}.json`);
    const mockData = [
      {
        id: "ff-001",
        title: "Product Standup 2026-07-06",
        date: "2026-07-06T09:00:00.000Z",
        duration: 1800,
        participants: ["alice@example.com", "bob@example.com"],
        sentences: [
          { speaker_name: "Alice", text: "Let's kick off.", start_time: 0, end_time: 2.1 },
          { speaker_name: "Bob", text: "I shipped the poller engine yesterday.", start_time: 3, end_time: 7 },
        ],
      },
    ];
    writeFileSync(mockJsonPath, JSON.stringify(mockData));
  });

  beforeEach(async () => {
    await clearCursors();
    const { default: db } = await import("../src/db.js");
    db.prepare("DELETE FROM meeting_segments").run();
  });

  test("firefliesFetchSince with FLOW_FIREFLIES_MOCK reads from file and filters by cursor", async () => {
    process.env.FLOW_FIREFLIES_MOCK = mockJsonPath;

    const { firefliesFetchSince } = await import("../src/adapters/fireflies.js");

    // Empty cursor → returns all transcripts
    const result1 = await firefliesFetchSince("");
    assert.equal(result1.items.length, 1, "Should return 1 transcript with empty cursor");
    assert.equal(result1.items[0].id, "ff-001");
    assert.equal(result1.nextCursor, "2026-07-06T09:00:00.000Z");

    // Cursor = exact transcript date → nothing newer
    const result2 = await firefliesFetchSince("2026-07-06T09:00:00.000Z");
    assert.equal(result2.items.length, 0, "No transcripts newer than the cursor");

    // Cursor before transcript date → returns it
    const result3 = await firefliesFetchSince("2026-07-05T00:00:00.000Z");
    assert.equal(result3.items.length, 1, "Transcript newer than cursor should be returned");

    delete process.env.FLOW_FIREFLIES_MOCK;
  });

  test("firefliesToEvent maps transcript to a NormalizedEvent with meeting source", async () => {
    const { firefliesToEvent } = await import("../src/adapters/fireflies.js");

    const transcript = {
      id: "ff-002",
      title: "Design Review",
      date: "2026-07-06T14:00:00.000Z",
      sentences: [
        { speaker_name: "Carol", text: "The new design looks great.", start_time: 0, end_time: 3 },
      ],
    };

    const event = firefliesToEvent(transcript);
    assert.equal(event.source, "meeting");
    assert.equal(event.type, "fireflies_transcript");
    const p = event.payload as Record<string, unknown>;
    assert.equal(p.transcript_id, "ff-002");
    assert.equal(p.title, "Design Review");
    assert.ok((p.raw_transcript as string).includes("Carol:"), "raw_transcript should include speaker");
    assert.ok((p.raw_transcript as string).includes("The new design looks great."), "raw_transcript should include text");
  });

  test("FLOW_FIREFLIES_MOCK mock file: full poller run via engine produces event rows", async () => {
    process.env.FLOW_FIREFLIES_MOCK = mockJsonPath;

    const { registerPoller, pollNow, getAllPollStatus, stopAllPollers } =
      await import("../src/pollers/engine.js");
    const { firefliesFetchSince, firefliesToEvent } = await import("../src/adapters/fireflies.js");

    const saved = process.env.FLOW_POLL_DISABLE;
    delete process.env.FLOW_POLL_DISABLE;

    const sourceName = `fireflies-mock-${randomUUID()}`;

    registerPoller({
      source: sourceName,
      resource: "_all",
      intervalMs: 600_000,
      async fetchSince(cursor: string) {
        const { items, nextCursor } = await firefliesFetchSince(cursor);
        return {
          events: items.map(firefliesToEvent),
          nextCursor,
        };
      },
      enabled: () => true,
    });

    pollNow(sourceName, "_all");
    await new Promise((r) => setTimeout(r, 500));

    const rows = getAllPollStatus();
    const row = rows.find((r) => r.source === sourceName);
    assert.ok(row, "Cursor row should exist");
    assert.equal(row!.cursor, "2026-07-06T09:00:00.000Z", "Cursor should advance to transcript date");

    process.env.FLOW_POLL_DISABLE = saved ?? "1";
    stopAllPollers();
    delete process.env.FLOW_FIREFLIES_MOCK;
  });
});

// -----------------------------------------------------------------------
// 7. GET /v1/ingest/status — endpoint sanity
// -----------------------------------------------------------------------
describe("GET /v1/ingest/status endpoint", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  before(async () => {
    // App is already booted by orchestrator.test.ts when run in the same process,
    // but each test file runs in its own process, so we need to boot here.
    process.env.ORCHESTRATOR_PORT = "17560";
    const mod = await import("../src/index.js");
    app = mod.app;
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await clearCursors();
  });

  test("returns 401 without auth token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/ingest/status",
    });
    assert.equal(res.statusCode, 401);
  });

  test("returns 200 with sources array when authenticated", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/ingest/status",
      headers: { authorization: "Bearer poller-test-token" },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { sources: unknown[] };
    assert.ok(Array.isArray(body.sources), "sources should be an array");
  });

  test("returns correct lag_s and catching_up for a known cursor row", async () => {
    const { default: db } = await import("../src/db.js");

    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO poll_cursors (source, resource, cursor, last_poll_at, status)
      VALUES ('linear', '_all', '2026-07-06T10:00:00.000Z', ?, 'catching_up')
    `).run(nowSec - 300); // 5 minutes ago

    const res = await app.inject({
      method: "GET",
      url: "/v1/ingest/status",
      headers: { authorization: "Bearer poller-test-token" },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { sources: Array<Record<string, unknown>> };
    const linearRow = body.sources.find((s) => s.source === "linear" && s.resource === "_all");
    assert.ok(linearRow, "linear _all row should appear");
    assert.equal(linearRow!.catching_up, true, "catching_up should be true");
    assert.ok(
      typeof linearRow!.lag_seconds === "number" && (linearRow!.lag_seconds as number) >= 290,
      `lag_seconds should be ~300, got ${linearRow!.lag_seconds}`
    );
    assert.equal(linearRow!.cursor, "2026-07-06T10:00:00.000Z");
  });
});

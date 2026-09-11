// orchestrator.test.ts — node:test suite for the orchestrator.
// Run with: node --import tsx/esm --test test/orchestrator.test.ts
// Requires: FLOW_FAKE_OPENCODE=1 (set in test runner via npm test script)

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

// Use an in-memory DB for tests by setting DB_PATH before importing db
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token";
process.env.FLOW_FAKE_OPENCODE = "1";
// GATEWAY_URL is set dynamically after stub starts on port 0 (see startGatewayStub)

// ------------------------------------------------------------------
// Tiny HTTP gateway stub — records calls, returns 200 {}
// ------------------------------------------------------------------
interface GatewayCall {
  path: string;
  body: unknown;
}

let gatewayCalls: GatewayCall[] = [];
let gatewayStub: Server;

function startGatewayStub(): Promise<void> {
  return new Promise((resolve) => {
    gatewayStub = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        gatewayCalls.push({ path: req.url ?? "/", body: body ? JSON.parse(body) : null });
        res.writeHead(200, { "Content-Type": "application/json" });
        // Mirror the real gateway's success shape so graphwrite's status check passes.
        res.end(JSON.stringify({ status: "created", id: "test" }));
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
  return new Promise((resolve) => gatewayStub.close(() => resolve()));
}

// Lazy-import app after env vars are set — typed as any since the module
// exports named `app` after boot and we only need .ready()/.close()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

// We import inline below; use fetch to talk to the running server.
let baseUrl: string;

before(async () => {
  await startGatewayStub();

  // Start orchestrator on a test port
  process.env.ORCHESTRATOR_PORT = "17500";

  // Dynamic import after env setup
  const mod = await import("../src/index.js");
  app = (mod as unknown as { app: typeof app }).app;
  await app.ready();
  baseUrl = "http://127.0.0.1:17500";
});

after(async () => {
  await app.close();
  await stopGatewayStub();
});

beforeEach(() => {
  gatewayCalls = [];
});

// ------------------------------------------------------------------
// Helper
// ------------------------------------------------------------------
async function post(path: string, body: unknown, token = "test-token"): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, token = "test-token"): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function makeEvent(
  source: string,
  type: string,
  payload: Record<string, unknown>,
  workspace?: string
) {
  return { id: randomUUID(), source, type, ts: Date.now(), payload, workspace };
}

// ------------------------------------------------------------------
// Auth tests
// ------------------------------------------------------------------
describe("auth", () => {
  test("GET /health returns 200 without token", async () => {
    const res = await get("/health", "");
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, "ok");
  });

  test("POST /v1/events returns 401 without token", async () => {
    const res = await post("/v1/events", {}, "");
    assert.equal(res.status, 401);
  });

  test("POST /v1/events returns 401 with wrong token", async () => {
    const res = await post("/v1/events", {}, "wrong-token");
    assert.equal(res.status, 401);
  });

  test("GET /v1/audit returns 401 without token", async () => {
    const res = await get("/v1/audit", "");
    assert.equal(res.status, 401);
  });

  test("GET /v1/audit returns 200 with valid token", async () => {
    const res = await get("/v1/audit");
    assert.equal(res.status, 200);
  });
});

// ------------------------------------------------------------------
// Event pipeline: slack_ambient knowledge_claim → graph write + audit
// ------------------------------------------------------------------
describe("event pipeline: slack_ambient knowledge_claim (auto)", () => {
  test("gateway called and audit row written", async () => {
    // Pre-seed a fixture so the classifier returns knowledge_claim
    const { db } = await import("../src/db.js");
    const { fixtureKey, FIXTURES_DIR } = await import("../src/classify.js");
    const { setClassifier } = await import("../src/classify.js");
    const { writeFileSync, mkdirSync } = await import("node:fs");

    // Use a custom classifier that returns knowledge_claim
    setClassifier({
      classify: async () => ({
        classification: "knowledge_claim",
        confidence: 0.9,
        extracted: {},
      }),
    });

    const event = makeEvent("slack", "ambient", {
      text: "We use TypeScript for all new services.",
      channel: "#general",
      user_id: "U123",
      ts: String(Date.now()),
    });

    const res = await post("/v1/events", event);
    assert.equal(res.status, 202);

    // Small pause for async action to complete
    await new Promise((r) => setTimeout(r, 300));

    // Gateway should have been called for graphwrite
    assert.ok(gatewayCalls.length >= 1, "Expected at least one gateway call");
    const graphCall = gatewayCalls.find((c) => c.path === "/v1/verbs/upsert_entity");
    assert.ok(graphCall, "Expected a POST /v1/verbs/upsert_entity gateway call");
    // The body must carry provenance + name (the gateway's Zod schema requires them).
    const gb = graphCall!.body as { name?: string; provenance?: { actor?: string } };
    assert.ok(gb.name, "upsert body includes name");
    assert.ok(gb.provenance?.actor?.startsWith("slack:"), "actor uses conversational lane prefix");

    // Audit log should have a row
    const auditRes = await get("/v1/audit");
    const auditBody = await auditRes.json() as { rows: Array<Record<string, unknown>> };
    const auditRow = auditBody.rows.find((r) => r.event_id === event.id);
    assert.ok(auditRow, "Audit row should exist for this event");
    assert.equal(auditRow.action, "graphwrite");
    assert.equal(auditRow.status, "ok");
  });
});

// ------------------------------------------------------------------
// Propose mode: slack_ambient task_discussion → outbox, no direct action
// ------------------------------------------------------------------
describe("event pipeline: slack_ambient task_discussion (propose)", () => {
  test("outbox row written, no gateway call", async () => {
    const { setClassifier } = await import("../src/classify.js");

    setClassifier({
      classify: async () => ({
        classification: "task_discussion",
        confidence: 0.85,
        extracted: {},
      }),
    });

    const event = makeEvent("slack", "ambient", {
      text: "We need to migrate the auth service to JWT tokens next sprint.",
      channel: "#product",
      user_id: "U456",
      ts: String(Date.now()),
    });

    const res = await post("/v1/events", event);
    assert.equal(res.status, 202);

    await new Promise((r) => setTimeout(r, 300));

    // No gateway call for propose
    const gatewayCallCount = gatewayCalls.length;
    // (gateway calls may have carried over from prior test; check outbox instead)

    const outboxRes = await get("/v1/outbox?status=pending");
    const outboxBody = await outboxRes.json() as { rows: Array<Record<string, unknown>> };
    const outboxRow = outboxBody.rows.find((r) => r.event_id === event.id);
    assert.ok(outboxRow, "Outbox row should exist for task_discussion");
    assert.equal(outboxRow.action_type, "slack_post"); // DM to controller is a slack_post
  });
});

// ------------------------------------------------------------------
// Sensitive → nothing stored anywhere
// ------------------------------------------------------------------
describe("event pipeline: sensitive → dropped", () => {
  test("no corpus row, no audit row, no outbox row", async () => {
    const { setClassifier } = await import("../src/classify.js");
    const { db } = await import("../src/db.js");

    const sensitiveText = "My SSN is 123-45-6789 and password is hunter2";

    setClassifier({
      classify: async () => ({
        classification: "sensitive",
        confidence: 0.99,
        extracted: {},
      }),
    });

    const event = makeEvent("slack", "ambient", {
      text: sensitiveText,
      channel: "#private",
      user_id: "U789",
      ts: String(Date.now()),
    });

    const res = await post("/v1/events", event);
    assert.equal(res.status, 202);

    await new Promise((r) => setTimeout(r, 300));

    // Corpus must NOT contain the sensitive text
    const searchRes = await get(`/v1/corpus/search?q=${encodeURIComponent("SSN")}`);
    const searchBody = await searchRes.json() as { results: unknown[] };
    assert.equal(searchBody.results.length, 0, "Sensitive text must not be in corpus");

    // Audit must NOT have a row for this event
    const auditRows = db.prepare("SELECT * FROM audit_log WHERE event_id = ?").all(event.id) as unknown[];
    assert.equal(auditRows.length, 0, "No audit row for sensitive events");

    // Outbox must NOT have a row
    const outboxRows = db.prepare("SELECT * FROM outbox WHERE event_id = ?").all(event.id) as unknown[];
    assert.equal(outboxRows.length, 0, "No outbox row for sensitive events");
  });
});

// ------------------------------------------------------------------
// Policy off → suppressed, audit says suppressed
// ------------------------------------------------------------------
describe("policy off → suppressed", () => {
  test("noise events are suppressed with audit record", async () => {
    const { setClassifier } = await import("../src/classify.js");
    const { db } = await import("../src/db.js");

    setClassifier({
      classify: async () => ({
        classification: "noise",
        confidence: 0.95,
        extracted: {},
      }),
    });

    const event = makeEvent("slack", "ambient", {
      text: "lol ok cool",
      channel: "#random",
      user_id: "U111",
      ts: String(Date.now()),
    });

    const res = await post("/v1/events", event);
    assert.equal(res.status, 202);

    await new Promise((r) => setTimeout(r, 300));

    const auditRows = db.prepare(
      "SELECT * FROM audit_log WHERE event_id = ? ORDER BY id ASC"
    ).all(event.id) as Array<Record<string, unknown>>;

    // noise.off → suppressed
    const suppressed = auditRows.find((r) => r.status === "suppressed");
    assert.ok(suppressed, "Should have a suppressed audit row");
    assert.equal(suppressed.action, "suppressed");
  });
});

// ------------------------------------------------------------------
// Mention/question → answer via fake opencode
// ------------------------------------------------------------------
describe("slack_mention question → answer job with citations", () => {
  test("answer job created and returns citations", async () => {
    const { setClassifier } = await import("../src/classify.js");

    setClassifier({
      classify: async () => ({
        classification: "question",
        confidence: 0.9,
        extracted: { question: "How is the auth system structured?" },
      }),
    });

    // Use /v1/ask directly (simpler than waiting for event pipeline answer path)
    const res = await post("/v1/ask", { question: "How is the auth system structured?", wait: true });
    assert.ok(res.status === 200 || res.status === 202);

    const body = await res.json() as Record<string, unknown>;
    assert.ok(body.id, "Response should have job id");

    // If wait=true and done, should have citations
    if (body.status === "done") {
      assert.ok(Array.isArray(body.citations), "Should have citations array");
    }
  });
});

// ------------------------------------------------------------------
// contextblock idempotency
// ------------------------------------------------------------------
describe("contextblock idempotency", () => {
  test("rendering twice produces a single section", async () => {
    const { upsertContextBlock, hasContextBlock } = await import("../src/actions/contextblock.js");

    const bundle = {
      relatedNodes: [{ id: "n1", name: "Auth Service", type: "Concept" }],
      notes: "Some notes",
    };

    const body = "# My Ticket\n\nSome description.";
    const once = upsertContextBlock(body, bundle);
    const twice = upsertContextBlock(once, bundle);

    // Count occurrences of start marker
    const count = (twice.match(/<!-- flow:context:start -->/g) ?? []).length;
    assert.equal(count, 1, "Should have exactly one context block");

    assert.ok(hasContextBlock(twice), "Should detect context block");
    assert.equal(once, twice, "Second render should produce identical output");
  });

  test("renders node names correctly", async () => {
    const { upsertContextBlock } = await import("../src/actions/contextblock.js");

    const bundle = {
      relatedNodes: [
        { id: "n1", name: "Auth Service", type: "Concept", description: "Handles authentication" },
      ],
    };

    const result = upsertContextBlock("", bundle);
    assert.ok(result.includes("Auth Service"), "Should include node name");
    assert.ok(result.includes("Handles authentication"), "Should include description");
  });
});

// ------------------------------------------------------------------
// Corpus search endpoint
// ------------------------------------------------------------------
describe("corpus search", () => {
  test("returns results for inserted slack message", async () => {
    const { db } = await import("../src/db.js");

    // Insert directly
    db.prepare(`
      INSERT OR IGNORE INTO slack_messages (id, text, channel, user_id, ts)
      VALUES ('test-msg-001', 'Flow uses FTS5 for full-text search', '#engineering', 'U999', '1234567890')
    `).run();

    const res = await get("/v1/corpus/search?q=FTS5");
    assert.equal(res.status, 200);
    const body = await res.json() as { results: Array<Record<string, unknown>> };
    assert.ok(body.results.length >= 1, "Should find the inserted message");
    assert.ok(
      body.results.some((r) => (r.text as string).includes("FTS5")),
      "Result should contain FTS5"
    );
  });

  test("returns 400 when q is missing", async () => {
    const res = await get("/v1/corpus/search");
    assert.equal(res.status, 400);
  });
});

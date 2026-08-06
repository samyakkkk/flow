// session-close.test.ts — the OS-process side of ending a session.
//
// Offline + hermetic like agent-diff.test.ts: rows inserted straight into the
// in-memory DB, no adapters spawned. What CAN be tested without a live ACP
// backend: closeFlowSession's row semantics (close, idempotence, unknown id)
// and that the reaper's idle-close writes the idle_timeout stop reason. The
// adapter-side teardown (session/close → child killed) is exercised by the
// manual repro in docs/ARCHITECTURE.md's lifecycle section.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE importing anything that touches the DB.
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-admin-token-sessionclose";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";
process.env.FLOW_DISTILLER = "0";
process.env.FLOW_AGENT_REAPER = "0"; // no background timer in tests

let db: typeof import("../src/db.js").default;
let closeFlowSession: typeof import("../src/agents/runtime.js").closeFlowSession;

function insertRow(id: string, status: string, acpId: string | null = null): void {
  db.prepare(
    `INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, acp_session_id, created_at, updated_at)
     VALUES (?, 'claude', 'r', '/tmp', 't', ?, ?, ?, ?)`
  ).run(id, status, acpId, Date.now(), Date.now());
}

function rowOf(id: string): { status: string; stop_reason: string | null } {
  return db.prepare(`SELECT status, stop_reason FROM agent_sessions WHERE id = ?`).get(id) as {
    status: string;
    stop_reason: string | null;
  };
}

describe("closeFlowSession", () => {
  before(async () => {
    db = (await import("../src/db.js")).default;
    ({ closeFlowSession } = await import("../src/agents/runtime.js"));
  });

  test("unknown session → error", async () => {
    const r = await closeFlowSession("nope");
    assert.deepEqual(r, { error: "Unknown session" });
  });

  test("row without an ACP id (died in starting) is closed in place", async () => {
    insertRow("s1", "starting");
    const r = await closeFlowSession("s1");
    assert.deepEqual(r, { ok: true });
    assert.equal(rowOf("s1").status, "closed");
    assert.equal(rowOf("s1").stop_reason, "closed");
  });

  test("idle_timeout reason lands in stop_reason", async () => {
    insertRow("s2", "error");
    const r = await closeFlowSession("s2", "idle_timeout");
    assert.deepEqual(r, { ok: true });
    assert.equal(rowOf("s2").status, "closed");
    assert.equal(rowOf("s2").stop_reason, "idle_timeout");
  });

  test("closing an already-closed session is a no-op ok", async () => {
    insertRow("s3", "closed");
    const r = await closeFlowSession("s3");
    assert.deepEqual(r, { ok: true });
    assert.equal(rowOf("s3").status, "closed");
  });
});

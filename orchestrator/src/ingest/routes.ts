// routes.ts — external-session capture. Hook shims (flow-hook) and the
// opencode plugin POST here; each external session becomes an agent_sessions
// row + JSONL transcript in the SAME shapes ACP sessions use, so the whole
// distiller pipeline (close trigger + 45-min idle sweep + slimTranscript)
// consumes them with zero changes. Sessions Flow itself runs are excluded at
// the source: the shim skips when FLOW_SESSION_ID is set in the harness env.
//
// Dedupe: hooks can re-fire and shims retry, so every (session, event) carries
// a content-hash key recorded in ingest_seen — re-posts are acknowledged but
// append nothing. This is the server half of the watermark story; the shim's
// byte-offset watermark on transcript files is the client half.

import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import db from "../db.js";
import { appendTranscriptEvents, readTranscript } from "../agents/runtime.js";
import { onSessionClosed } from "../memory/trigger.js";
import {
  normalizeHook,
  normalizeOpencodeMessage,
  type NormalizedEvent,
  type OpencodeMessage,
} from "./adapters.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS ingest_seen (
    ext_id TEXT NOT NULL,
    key    TEXT NOT NULL,
    at     INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (ext_id, key)
  )
`);

const seenStmt = () => db.prepare(`INSERT OR IGNORE INTO ingest_seen (ext_id, key) VALUES (?, ?)`);
const rowStmt = () => db.prepare(`SELECT id, status FROM agent_sessions WHERE id = ?`);
const insertStmt = () =>
  db.prepare(
    `INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
const touchStmt = () => db.prepare(`UPDATE agent_sessions SET updated_at = ? WHERE id = ?`);
const titleStmt = () =>
  db.prepare(`UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ? AND title = ''`);
const closeStmt = () =>
  db.prepare(`UPDATE agent_sessions SET status = 'closed', updated_at = ? WHERE id = ?`);

export function extRowId(harness: string, externalId: string, userId: string | null = null): string {
  // Harness session ids are uuids/slugs; sanitize defensively — this id
  // becomes a filename in agent-sessions/.
  const safeExt = externalId.replace(/[^A-Za-z0-9._-]/g, "_");
  // Namespace by the authenticated user (the PAT owner, stamped by the dashboard
  // proxy) so a member cannot forge a session as another user/harness nor append
  // to someone else's session id — that would poison the shared brain once
  // distilled. Local/unattributed captures (single user) keep the legacy id.
  if (userId) {
    const safeUser = userId.replace(/[^A-Za-z0-9._-]/g, "_");
    return `ext-${safeUser}-${harness}-${safeExt}`;
  }
  return `ext-${harness}-${safeExt}`;
}

function hashKey(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

// The authenticated PAT owner. The dashboard proxy verifies the caller's PAT and
// stamps `x-flow-pat-user` (overwriting any client value); the orchestrator is
// 127.0.0.1-only behind the admin token, so the header is trustworthy here.
// null = local mode (single user) or an unattributed post — legacy id, no
// namespacing. Used to scope captured sessions per user (anti-forgery).
function patUserOf(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const h = req.headers["x-flow-pat-user"];
  return typeof h === "string" && h.trim() ? h.trim() : null;
}

interface UpsertArgs {
  harness: string;
  externalId: string;
  repo: string | null;
  cwd: string | null;
  title: string | null;
  userId?: string | null;
}

function upsertExternalSession(a: UpsertArgs): string {
  const id = extRowId(a.harness, a.externalId, a.userId ?? null);
  const now = Date.now();
  const row = rowStmt().get(id) as { id: string } | undefined;
  if (!row) {
    insertStmt().run(id, `ext:${a.harness}`, a.repo ?? "", a.cwd ?? "", a.title ?? "", "idle", now, now);
  } else {
    touchStmt().run(now, id);
    if (a.title) titleStmt().run(a.title, now, id);
  }
  return id;
}

function appendNew(id: string, events: NormalizedEvent[]): number {
  if (events.length === 0) return 0;
  return appendTranscriptEvents(id, events);
}

export interface HookBody {
  harness: string;
  event: Record<string, unknown>;
  repo?: string | null;
  branch?: string | null;
  project?: string | null; // informational — this orchestrator IS one project
  shim_version?: string;
}

export function registerIngestRoutes(app: FastifyInstance): void {
  app.post<{ Body: HookBody }>("/v1/ingest/hook", async (req, reply) => {
    const { harness, event, repo, branch } = req.body ?? ({} as HookBody);
    if (!harness || !event || typeof event !== "object") {
      return reply.code(400).send({ error: "harness and event required" });
    }
    const norm = normalizeHook(harness, event, repo ?? null);
    if (!norm.externalId) return reply.code(202).send({ ignored: true, reason: "no session id" });

    const id = upsertExternalSession({
      harness,
      externalId: norm.externalId,
      repo: repo ?? null,
      cwd: norm.cwd,
      title: norm.title,
      userId: patUserOf(req),
    });

    // One hook event = one dedupe unit. The hash covers the payload, so a
    // legitimately repeated event name with new content (second Stop of a
    // multi-turn session) still lands.
    const key = hashKey([norm.eventName, event]);
    const fresh = seenStmt().run(id, key).changes === 1;
    let appended = 0;
    if (fresh) appended = appendNew(id, norm.events) ? norm.events.length : 0;

    if (norm.closed) {
      closeStmt().run(Date.now(), id);
      onSessionClosed(id, branch ?? null);
    }
    return { ok: true, session: id, appended, dup: !fresh, closed: norm.closed };
  });

  app.post<{
    Body: {
      harness?: string;
      sessionID?: string;
      directory?: string | null;
      repo?: string | null;
      branch?: string | null;
      messages?: OpencodeMessage[];
      closed?: boolean;
    };
  }>("/v1/ingest/opencode", async (req, reply) => {
    const b = req.body ?? {};
    if (!b.sessionID || !Array.isArray(b.messages)) {
      return reply.code(400).send({ error: "sessionID and messages required" });
    }
    const firstUser = b.messages.find((m) => m.role === "user");
    const firstText = firstUser?.parts?.find((p) => p?.type === "text")?.text ?? null;
    const id = upsertExternalSession({
      harness: "opencode",
      externalId: b.sessionID,
      repo: b.repo ?? null,
      cwd: b.directory ?? null,
      title: firstText ? firstText.slice(0, 80) : null,
      userId: patUserOf(req),
    });
    if (readTranscript(id).length === 0) {
      appendNew(id, [
        { kind: "created", data: { repo: b.repo ?? "", backend: "ext:opencode", title: firstText?.slice(0, 80) ?? "" } },
      ]);
    }

    let appended = 0;
    for (let i = 0; i < b.messages.length; i++) {
      const msg = b.messages[i];
      const ev = normalizeOpencodeMessage(msg);
      if (!ev) continue;
      // Message ids are stable across idle re-posts; content-hash fallback
      // covers SDK versions that stop exposing ids.
      const key = hashKey([msg.id ?? `idx-${i}`, ev.data]);
      if (seenStmt().run(id, key).changes === 1) {
        appendNew(id, [ev]);
        appended++;
      }
    }
    if (b.closed) {
      closeStmt().run(Date.now(), id);
      onSessionClosed(id, b.branch ?? null);
    }
    return { ok: true, session: id, appended };
  });

  // Test/report oracle: list captured external sessions (+ optional transcript
  // text match) without shelling into sqlite. Powers the e2e sentinel checks.
  app.get<{ Querystring: { harness?: string; contains?: string } }>(
    "/v1/ingest/sessions",
    async (req) => {
      const like = req.query.harness ? `ext:${req.query.harness}` : "ext:%";
      const rows = db
        .prepare(
          `SELECT id, backend, repo, cwd, title, status, last_distilled_seq, created_at, updated_at
           FROM agent_sessions WHERE backend LIKE ? ORDER BY updated_at DESC LIMIT 50`
        )
        .all(like) as Array<Record<string, unknown>>;
      const contains = req.query.contains;
      const sessions = rows.map((r) => {
        const events = readTranscript(String(r.id));
        return {
          ...r,
          events: events.length,
          matched: contains ? JSON.stringify(events).includes(contains) : undefined,
        };
      });
      return { sessions: contains ? sessions.filter((s) => s.matched) : sessions };
    }
  );
}

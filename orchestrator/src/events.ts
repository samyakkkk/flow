// events.ts — Normalized event type + ingest route.
// POST /v1/events — accepts event, runs classify→policy→action pipeline.
// GET  /v1/events/:id — returns event row + classification + actions from audit_log.

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { classify, taxonomyKey } from "./classify.js";
import { policyFor } from "./policy.js";
import { executeAction } from "./actions/index.js";

// Contract shape from system.md
export interface NormalizedEvent {
  id: string;
  source: "slack" | "linear" | "github" | "meeting" | "dashboard";
  type: string;       // adapter-specific sub-type, e.g. "message", "mention", "merge", "webhook"
  ts: number;         // unix epoch ms
  payload: Record<string, unknown>;
  workspace?: string;
}

// High-signal secret formats. Deliberately narrow — false positives silently
// drop real messages, so only patterns that are unambiguously credentials.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,                  // OpenAI/OpenRouter-style keys
  /\bxox[bapo]-[A-Za-z0-9-]{10,}\b/,            // Slack tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,           // GitHub fine-grained PAT
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,             // GitHub classic tokens
  /\blin_api_[A-Za-z0-9]{20,}\b/,               // Linear API keys
  /\bAKIA[0-9A-Z]{16}\b/,                       // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,         // PEM private keys
];

// Exported so corpus-writing paths (e.g. meeting ingest) can screen text
// BEFORE persisting it — the corpus must never hold a credential either.
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (id, source, type, ts, payload, workspace)
  VALUES (@id, @source, @type, @ts, @payload, @workspace)
`);

const selectThreadSession = db.prepare(
  `SELECT * FROM thread_sessions WHERE thread_key = ?`
);

const touchThreadSession = db.prepare(
  `UPDATE thread_sessions SET last_activity = unixepoch(), status = 'active'
   WHERE thread_key = ?`
);

const selectEvent = db.prepare(`SELECT * FROM events WHERE id = ?`);

const updateEventClassification = db.prepare(`
  UPDATE events SET classification_json = @classification_json WHERE id = @id
`);

const selectAuditByEvent = db.prepare(`
  SELECT * FROM audit_log WHERE event_id = ? ORDER BY id ASC
`);

export async function processEvent(event: NormalizedEvent): Promise<void> {
  // Deterministic secret scan BEFORE the row is ever persisted — no TOCTOU
  // window where GET /v1/events/:id could read a credential (S039/S040). The
  // sensitive hard-drop must not depend on the LLM recognizing a token format.
  const flat = JSON.stringify(event.payload);
  if (SECRET_PATTERNS.some((re) => re.test(flat))) {
    // Nothing stored, no audit — same contract as classifier-detected sensitive.
    return;
  }

  // 1. Persist event (idempotent: OR IGNORE on duplicate id)
  insertEvent.run({
    id: event.id,
    source: event.source,
    type: event.type,
    ts: event.ts,
    payload: JSON.stringify(event.payload),
    workspace: event.workspace ?? null,
  });

  // ------------------------------------------------------------------
  // G10: Session-per-chat routing.
  // If this slack message belongs to a thread that already has a bound
  // opencode session, skip the classifier entirely and enqueue a
  // "continue" job directly into that session.
  // ------------------------------------------------------------------
  if (event.source === "slack") {
    const p = event.payload as Record<string, string | undefined>;
    const channel = p.channel ?? "";
    const thread_ts = p.thread_ts ?? p.ts ?? "";
    const thread_key = `${event.workspace ?? ""}:${channel}:${thread_ts}`;

    const sessionRow = selectThreadSession.get(thread_key) as
      | { thread_key: string; session_id: string; job_id: string; status: string }
      | undefined;

    if (sessionRow?.session_id) {
      // Touch last_activity
      touchThreadSession.run(thread_key);

      // Enqueue continuation into the existing opencode session
      const { enqueueJob } = await import("./opencode.js");
      const job = await enqueueJob({
        type: "continue",
        input: {
          message: p.text ?? "",
          session_id: sessionRow.session_id,
          reply_to: { channel, thread_ts },
          workspace: event.workspace ?? "",
          event_id: event.id,
        },
      });

      // Audit — action "session_continue", no classify row
      db.prepare(
        `INSERT INTO audit_log (event_id, classification, confidence, action, target, status)
         VALUES (?, 'continuation', 1.0, 'session_continue', ?, 'ok')`
      ).run(event.id, job.id);

      return; // skip classifier
    }
  }

  // Deterministic dashboard commands skip the classifier entirely.
  if (event.source === "dashboard" && event.type === "reindex_request") {
    const p = event.payload as { repo?: string; branch?: string };
    const { enqueueJob, listWorkspaceRepos, registerSource } = await import("./opencode.js");
    // Branch change: sync the durable registry and the in-memory push poller
    // so merges to the new branch trigger reindexes immediately — the poller
    // map is only re-seeded from repos.json at boot. watchRepo is idempotent,
    // so re-watching on every reindex also heals a map that went stale when
    // the dashboard edited repos.json directly.
    if (p.repo && p.branch) {
      const entry = listWorkspaceRepos().find((r) => r.name === p.repo);
      if (entry) {
        if (entry.branch !== p.branch) {
          registerSource({ name: p.repo, branch: p.branch });
          const { indexLog } = await import("./index-log.js");
          indexLog(p.repo, "watch", undefined, { branch: p.branch, previous: entry.branch });
        }
        if (entry.url) {
          const { watchRepo, watchKeyForUrl } = await import("./adapters/github.js");
          const watchKey = watchKeyForUrl(entry.url);
          if (watchKey) watchRepo(watchKey, p.branch);
        }
      }
    }
    const job = await enqueueJob({
      type: "index_repo",
      input: { repo: p.repo ?? "", branch: p.branch },
      repo: p.repo,
    });
    db.prepare(
      `INSERT INTO audit_log (event_id, classification, confidence, action, target, status) VALUES (?, 'reindex_request', 1.0, 'index_job', ?, 'ok')`
    ).run(event.id, job.id);
    return;
  }

  // Disconnecting a repo is a button click too — never classify it. The
  // dashboard already dropped the registry entry; this cleans up everything
  // else (poller watch, parked/queued jobs, clone dir, graph node) so a
  // removed repo doesn't keep being polled, indexed, and served as knowledge.
  if (event.source === "dashboard" && event.type === "repo_removed") {
    const p = event.payload as { repoName?: string; repo?: string };
    const name = (p.repoName ?? p.repo ?? "").trim();
    if (!name) {
      db.prepare(
        `INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail) VALUES (?, 'repo_removed', 1.0, 'rejected', '-', 'error', ?)`
      ).run(event.id, JSON.stringify({ error: "missing repoName" }));
      return;
    }
    const { removeRepo } = await import("./opencode.js");
    const summary = await removeRepo(name);
    db.prepare(
      `INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail) VALUES (?, 'repo_removed', 1.0, 'repo_cleanup', ?, 'ok', ?)`
    ).run(event.id, name, JSON.stringify(summary));
    return;
  }

  // Connecting a repo is a button click, not language — never classify it.
  // Register in the workspace registry, then queue an index job (the job
  // runner clones if the checkout is missing).
  if (event.source === "dashboard" && event.type === "repo_added") {
    const p = event.payload as { url?: string; branch?: string };
    if (!p.url) {
      db.prepare(
        `INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail) VALUES (?, 'repo_added', 1.0, 'rejected', '-', 'error', ?)`
      ).run(event.id, JSON.stringify({ error: "missing url" }));
      return;
    }
    // Register + watch + queue the index job via the shared connection path
    // (also used by the sources front door), then audit. A name collision
    // (two owners, same repo name) is refused, not silently overwritten.
    const { connectGithubRepo } = await import("./opencode.js");
    let entry, jobId;
    try {
      ({ entry, jobId } = await connectGithubRepo(p.url, p.branch));
    } catch (err) {
      db.prepare(
        `INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail) VALUES (?, 'repo_added', 1.0, 'rejected', '-', 'error', ?)`
      ).run(event.id, JSON.stringify({ error: String(err) }));
      return;
    }
    // target = the human-facing repo name (the dashboard shows it verbatim);
    // the job id lives in detail for debugging.
    db.prepare(
      `INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail) VALUES (?, 'repo_added', 1.0, 'index_job', ?, 'ok', ?)`
    ).run(event.id, entry.name, JSON.stringify({ job: jobId, branch: entry.branch }));
    return;
  }

  // A push to a watched base branch is a fact, not language — never classify
  // it. The poller already filters to registered {repo, branch}, so every
  // github push event is index-worthy by definition. Routing it through the
  // LLM added failure modes (skip verdicts, low confidence, missing API key)
  // that silently broke the merge → reindex → note-promotion loop.
  if (event.source === "github" && event.type === "push") {
    const classification = { classification: "index_worthy", confidence: 1.0, extracted: {} };
    updateEventClassification.run({ id: event.id, classification_json: JSON.stringify(classification) });
    const policy = policyFor("github_merge", "index_worthy");
    await executeAction({ event, classification, policy });
    return;
  }

  // 2. Classify
  const classification = await classify(event);
  updateEventClassification.run({ id: event.id, classification_json: JSON.stringify(classification) });

  // 3. Policy lookup — key uses taxonomy-level source (e.g. slack_ambient, slack_mention)
  const taxKey = taxonomyKey(event);
  const policy = policyFor(taxKey, classification.classification);

  // 4. Action (or suppress)
  await executeAction({ event, classification, policy });
}

export function registerEventRoutes(app: FastifyInstance): void {
  // POST /v1/events
  app.post<{ Body: Omit<NormalizedEvent, "id"> & { id?: string } }>(
    "/v1/events",
    async (req, reply) => {
      const body = req.body as Record<string, unknown>;

      // Minimal validation
      if (!body.source || !body.type || body.ts === undefined || !body.payload) {
        return reply.code(400).send({ error: "Missing required fields: source, type, ts, payload" });
      }

      const event: NormalizedEvent = {
        id: (body.id as string | undefined) ?? randomUUID(),
        source: body.source as NormalizedEvent["source"],
        type: body.type as string,
        ts: body.ts as number,
        payload: body.payload as Record<string, unknown>,
        workspace: body.workspace as string | undefined,
      };

      await processEvent(event);

      return reply.code(202).send({ id: event.id, status: "accepted" });
    }
  );

  // GET /v1/events/:id
  app.get<{ Params: { id: string } }>(
    "/v1/events/:id",
    async (req, reply) => {
      const row = selectEvent.get(req.params.id) as Record<string, unknown> | undefined;
      if (!row) return reply.code(404).send({ error: "Not found" });

      const actions = selectAuditByEvent.all(req.params.id);

      return reply.send({
        event: { ...row, payload: JSON.parse(row.payload as string) },
        actions,
      });
    }
  );
}

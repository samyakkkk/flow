// corrections.ts — Advisory graph-correction flags from coding agents.
//
// A coding agent (via the gateway's correct_graph verb) says "this node/edge
// looks wrong, here's why". The flag is NEVER applied directly: it enqueues a
// correct_graph job whose graph-builder agent verifies the claim against the
// repo's checkout under workspace/repos/<name> — a single-branch clone of the
// REGISTERED BASE BRANCH, never the flagging agent's working copy. That
// checkout is the ground truth that filters out branch-local state and
// plain-wrong flags. The indexer applies confirmed corrections through the
// normal graph_* write path (provenance + journal) and rejects the rest.
//
// Routes:
//   POST /v1/corrections   — file a flag (dedup: overlapping pending targets coalesce)
//   GET  /v1/corrections   — list (?status=, ?limit=) for the dashboard inbox

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import db from "./db.js";

export interface CorrectionRow {
  id: string;
  target_ids: string; // JSON array
  reason: string;
  evidence: string | null;
  repo: string | null;
  actor: string | null;
  session: string | null;
  graph_name: string | null;
  status: "pending" | "verifying" | "applied" | "rejected" | "unclear" | "failed";
  job_id: string | null;
  resolution: string | null;
  created_at: number;
  updated_at: number;
}

const insertCorrection = db.prepare(`
  INSERT INTO corrections (id, target_ids, reason, evidence, repo, actor, session, graph_name, status)
  VALUES (@id, @target_ids, @reason, @evidence, @repo, @actor, @session, @graph_name, 'pending')
`);

const updateCorrectionJob = db.prepare(`
  UPDATE corrections SET status = 'verifying', job_id = @job_id, updated_at = unixepoch() WHERE id = @id
`);

const resolveCorrection = db.prepare(`
  UPDATE corrections SET status = @status, resolution = @resolution, updated_at = unixepoch() WHERE id = @id
`);

const selectOpen = db.prepare(`
  SELECT id, target_ids FROM corrections WHERE status IN ('pending', 'verifying')
`);

// A flag whose targets overlap an open correction coalesces into it — two
// agents noticing the same stale node must not spawn two verification jobs.
function findOverlappingOpen(targetIds: string[]): string | null {
  const want = new Set(targetIds);
  const rows = selectOpen.all() as Array<{ id: string; target_ids: string }>;
  for (const row of rows) {
    try {
      const ids = JSON.parse(row.target_ids) as string[];
      if (ids.some((id) => want.has(id))) return row.id;
    } catch {
      /* malformed row — ignore */
    }
  }
  return null;
}

export async function fileCorrection(input: {
  target_ids: string[];
  reason: string;
  evidence?: string | null;
  repo?: string | null;
  actor?: string | null;
  session?: string | null;
  graph?: string | null;
}): Promise<{ id: string; status: "accepted" | "duplicate" }> {
  const existing = findOverlappingOpen(input.target_ids);
  if (existing) return { id: existing, status: "duplicate" };

  const id = randomUUID();
  insertCorrection.run({
    id,
    target_ids: JSON.stringify(input.target_ids),
    reason: input.reason,
    evidence: input.evidence ?? null,
    repo: input.repo ?? null,
    actor: input.actor ?? null,
    session: input.session ?? null,
    graph_name: input.graph ?? null,
  });

  // Dynamic import — opencode.ts must stay importable from here without a cycle
  // (it imports corrections.ts back for job resolution). If enqueue fails, the
  // row must not stay 'pending': open rows absorb future flags on the same
  // targets as duplicates, so a stuck one makes the inaccuracy un-flaggable.
  try {
    const { enqueueJob } = await import("./opencode.js");
    const job = await enqueueJob({
      type: "correct_graph",
      input: {
        correction_id: id,
        target_ids: input.target_ids,
        reason: input.reason,
        evidence: input.evidence ?? null,
        repo: input.repo ?? null,
      },
    });
    updateCorrectionJob.run({ id, job_id: job.id });
  } catch (err) {
    resolveCorrection.run({ id, status: "failed", resolution: `enqueue failed: ${String(err)}`.slice(0, 2000) });
    throw err;
  }
  return { id, status: "accepted" };
}

// Called by the job runner when a correct_graph job finishes. The agent is
// instructed to end with {"verdict": "applied"|"rejected", "summary": "..."} —
// an unparsable answer lands as 'unclear' (never silently 'applied': the
// dashboard shows it for a human to look at).
//
// Extraction mirrors opencode.ts's parseAnswerPayload lessons: try ```json
// fences first, then the brace span from the LAST '{' before the key to the
// LAST '}' in the text — the first '}' after the key is often inside the
// summary string ("updated props {status}") and truncates the JSON.
export function resolveFromJobResult(correctionId: string, raw: string, failed: boolean): void {
  if (failed) {
    resolveCorrection.run({ id: correctionId, status: "failed", resolution: raw.slice(0, 2000) });
    return;
  }
  const fenced = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fenced.reverse()];
  const key = raw.lastIndexOf('"verdict"');
  if (key >= 0) {
    const start = raw.lastIndexOf("{", key);
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  }
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand.trim()) as { verdict?: string; summary?: string };
      if (parsed.verdict === "applied" || parsed.verdict === "rejected") {
        resolveCorrection.run({
          id: correctionId,
          status: parsed.verdict,
          resolution: (parsed.summary ?? "").slice(0, 2000),
        });
        return;
      }
    } catch {
      /* try next candidate */
    }
  }
  resolveCorrection.run({ id: correctionId, status: "unclear", resolution: raw.slice(-2000) });
}

export function registerCorrectionRoutes(app: FastifyInstance): void {
  app.post<{
    Body: {
      target_ids?: string[];
      reason?: string;
      evidence?: string | null;
      repo?: string | null;
      actor?: string | null;
      session?: string | null;
      graph?: string | null;
    };
  }>("/v1/corrections", async (req, reply) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.target_ids) || b.target_ids.length === 0 || !b.reason) {
      return reply.code(400).send({ error: "target_ids (non-empty array) and reason are required" });
    }
    const result = await fileCorrection({
      target_ids: b.target_ids.map(String).slice(0, 10),
      reason: String(b.reason),
      evidence: b.evidence ?? null,
      repo: b.repo ?? null,
      actor: b.actor ?? null,
      session: b.session ?? null,
      graph: b.graph ?? null,
    });
    return reply.code(result.status === "duplicate" ? 200 : 202).send(result);
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>("/v1/corrections", async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit ?? "100", 10) || 100, 500);
    const status = req.query.status;
    const rows = status
      ? db.prepare(`SELECT * FROM corrections WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit)
      : db.prepare(`SELECT * FROM corrections ORDER BY created_at DESC LIMIT ?`).all(limit);
    return reply.send({ rows, count: rows.length });
  });
}

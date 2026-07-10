// notes.ts — Branch notes: Flow-side working memory scoped to (repo, branch).
//
// UNGATED by design ("memory must not need maintaining"): a note is an
// attributed utterance, not a truth claim — wrong ones cost little and decay.
// Never written into the user's repo; lives in flow.db so it works identically
// locally and on EC2 and migrates with flow export/import.
//
// Kinds and their merge fates:
//   wip                     — rolling state of a session's work on the branch;
//                             SUPERSEDES the session's previous wip note;
//                             swept at promotion (merged code carries it).
//   note | caution | decision — accumulate; promoted to graph Note nodes after
//                             the repo's base branch is reindexed (Phase 3).
//
// Embeddings are computed at write time (best-effort) and stored as BLOBs so
// turn-boundary injection can cosine-match in-process — no gateway hop.

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { blobToVec, cosine, embedText, vecToBlob } from "./embed.js";

export type NoteKind = "wip" | "note" | "caution" | "decision";
const KINDS = new Set<NoteKind>(["wip", "note", "caution", "decision"]);

export interface BranchNote {
  id: string;
  repo: string;
  branch: string;
  kind: NoteKind;
  text: string;
  anchor_hint: string | null;
  actor: string | null;
  session: string | null;
  status: "active" | "ready" | "promoted" | "swept";
  created_at: number;
  updated_at: number;
}

const insertNote = db.prepare(`
  INSERT INTO branch_notes (id, repo, branch, kind, text, anchor_hint, actor, session, embedding)
  VALUES (@id, @repo, @branch, @kind, @text, @anchor_hint, @actor, @session, @embedding)
`);

// wip supersede: one rolling wip note per (repo, branch, session).
const deletePriorWip = db.prepare(`
  DELETE FROM branch_notes WHERE repo = ? AND branch = ? AND kind = 'wip' AND session IS ?
`);

export async function addNote(input: {
  repo: string;
  branch: string;
  kind?: string;
  text: string;
  anchor_hint?: string | null;
  actor?: string | null;
  session?: string | null;
}): Promise<{ id: string }> {
  const kind: NoteKind = KINDS.has(input.kind as NoteKind) ? (input.kind as NoteKind) : "note";
  const id = randomUUID();
  // Best-effort vector; a note without one is stored but not injectable.
  const vec = await embedText(input.text.slice(0, 2000));
  if (kind === "wip") deletePriorWip.run(input.repo, input.branch, input.session ?? null);
  insertNote.run({
    id,
    repo: input.repo,
    branch: input.branch,
    kind,
    text: input.text.slice(0, 4000),
    anchor_hint: input.anchor_hint ?? null,
    actor: input.actor ?? null,
    session: input.session ?? null,
    embedding: vec ? vecToBlob(vec) : null,
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Injection matching (Phase 2 consumer). Loads active notes for the session's
// exact (repo, branch) — branch scoping IS this equality — and cosine-ranks
// them against an already-computed query vector. Pure arithmetic, no I/O
// beyond one indexed SELECT.

const selectActiveForBranch = db.prepare(`
  SELECT id, kind, text, embedding FROM branch_notes
  WHERE repo = ? AND branch = ? AND status = 'active' AND embedding IS NOT NULL
  ORDER BY updated_at DESC LIMIT 200
`);

export function matchNotes(
  queryVec: Float32Array,
  repo: string,
  branch: string,
  opts: { limit?: number; minSimilarity?: number } = {},
): Array<{ id: string; kind: string; text: string; similarity: number }> {
  const limit = opts.limit ?? 2;
  const min = opts.minSimilarity ?? 0.35;
  const rows = selectActiveForBranch.all(repo, branch) as Array<{
    id: string;
    kind: string;
    text: string;
    embedding: Buffer;
  }>;
  return rows
    .map((r) => ({ id: r.id, kind: r.kind, text: r.text, similarity: cosine(queryVec, blobToVec(r.embedding)) }))
    .filter((r) => r.similarity >= min)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Routes. POST is the gateway `note` verb's dispatch target; GET feeds the
// dashboard's notes strip; DELETE is human cleanup (the one curation act).

export function registerNoteRoutes(app: FastifyInstance): void {
  app.post<{
    Body: {
      repo?: string;
      branch?: string;
      kind?: string;
      text?: string;
      anchor_hint?: string | null;
      actor?: string | null;
      session?: string | null;
    };
  }>("/v1/notes", async (req, reply) => {
    const b = req.body ?? {};
    if (!b.repo || !b.branch || !b.text) {
      return reply.code(400).send({ error: "repo, branch, and text are required" });
    }
    const result = await addNote({
      repo: String(b.repo),
      branch: String(b.branch),
      kind: b.kind,
      text: String(b.text),
      anchor_hint: b.anchor_hint ?? null,
      actor: b.actor ?? null,
      session: b.session ?? null,
    });
    return reply.code(201).send({ id: result.id, status: "noted" });
  });

  app.get<{ Querystring: { repo?: string; branch?: string; status?: string; limit?: string } }>(
    "/v1/notes",
    async (req, reply) => {
      const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (req.query.repo) { clauses.push("repo = ?"); params.push(req.query.repo); }
      if (req.query.branch) { clauses.push("branch = ?"); params.push(req.query.branch); }
      clauses.push("status = ?");
      params.push(req.query.status ?? "active");
      const rows = db
        .prepare(
          `SELECT id, repo, branch, kind, text, anchor_hint, actor, session, status, created_at, updated_at
           FROM branch_notes WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...params, limit);
      return reply.send({ rows, count: rows.length });
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/notes/:id", async (req, reply) => {
    const info = db.prepare(`DELETE FROM branch_notes WHERE id = ?`).run(req.params.id);
    return reply.send({ deleted: info.changes > 0 });
  });
}

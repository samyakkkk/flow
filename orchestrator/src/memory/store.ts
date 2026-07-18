// store.ts — the single SQLite substrate for memory v1 (observations + memories)
// plus the in-process vector cache used by search. Embeddings are computed at
// WRITE time only; the embedder is INJECTED (default: the gateway-backed
// embedText) so tests can pass a deterministic stub and never load the model.

import { randomUUID } from "node:crypto";
import db from "../db.js";
import { blobToVec, vecToBlob, embedText as gatewayEmbed } from "../embed.js";
import { repoFamily } from "./repo-family.js";
import type { RawObservation } from "./parse.js";

// An embedder returns a 768-dim vector or null (model not ready). Injectable.
export type Embedder = (text: string) => Promise<Float32Array | null>;

let _embedder: Embedder = gatewayEmbed;
export function setEmbedder(fn: Embedder): void {
  _embedder = fn;
}
export function getEmbedder(): Embedder {
  return _embedder;
}

export interface ObservationRow {
  id: string;
  source: string;
  repo: string | null;
  repo_family: string | null;
  branch: string | null;
  session_id: string | null;
  claim: string;
  kind: string;
  source_weight: string;
  context_files: string | null;
  retrieval_keys: string | null;
  embedding: Buffer | null;
  memory_id: string | null;
  created_at: number;
}

export interface MemoryRow {
  id: string;
  claim: string;
  kind: string;
  repo: string | null;
  repo_family: string | null;
  strength: number;
  evidence_count: number;
  people_count: number;
  contradiction_count: number;
  last_reinforced_at: number | null;
  status: string;
  embedding: Buffer | null;
  retrieval_keys: string | null;
  max_source_weight: string;
  created_at: number;
  updated_at: number;
}

const insertObservationStmt = db.prepare(`
  INSERT INTO observations
    (id, source, repo, repo_family, branch, session_id, claim, kind, source_weight,
     context_files, retrieval_keys, embedding, memory_id)
  VALUES
    (@id, @source, @repo, @repo_family, @branch, @session_id, @claim, @kind, @source_weight,
     @context_files, @retrieval_keys, @embedding, @memory_id)
`);

export interface NewObservation {
  source: "session" | "slack" | "linear" | "meeting";
  repo?: string | null;
  branch?: string | null;
  session_id?: string | null;
  claim: string;
  kind: string;
  source_weight?: string;
  context_files?: string[];
  retrieval_keys?: string[];
  memory_id?: string | null;
}

// The text we embed for an observation: claim + retrieval keys (identifiers and
// error snippets carry the retrieval signal).
export function observationEmbedText(claim: string, keys: string[]): string {
  return keys.length ? `${claim}\n${keys.join(" ")}` : claim;
}

// Insert an observation, embedding at write time (best-effort). Returns the row.
export async function insertObservation(o: NewObservation): Promise<ObservationRow> {
  const id = randomUUID();
  const keys = o.retrieval_keys ?? [];
  const vec = await _embedder(observationEmbedText(o.claim, keys).slice(0, 2000));
  const row = {
    id,
    source: o.source,
    repo: o.repo ?? null,
    repo_family: repoFamily(o.repo),
    branch: o.branch ?? null,
    session_id: o.session_id ?? null,
    claim: o.claim,
    kind: o.kind,
    source_weight: o.source_weight ?? "agent_inferred",
    context_files: o.context_files && o.context_files.length ? JSON.stringify(o.context_files) : null,
    retrieval_keys: keys.length ? JSON.stringify(keys) : null,
    embedding: vec ? vecToBlob(vec) : null,
    memory_id: o.memory_id ?? null,
  };
  insertObservationStmt.run(row);
  invalidateVectorCache();
  return { ...row, created_at: Math.floor(Date.now() / 1000) };
}

// Map a distiller RawObservation → NewObservation (source always 'session').
export function rawToNewObservation(
  raw: RawObservation,
  ctx: { repo: string | null; branch: string | null; session_id: string | null },
): NewObservation {
  return {
    source: "session",
    repo: raw.context.repo ?? ctx.repo,
    branch: raw.context.branch ?? ctx.branch,
    session_id: ctx.session_id,
    claim: raw.claim,
    kind: raw.kind,
    source_weight: raw.source,
    context_files: raw.context.files ?? [],
    retrieval_keys: raw.retrieval_keys ?? [],
  };
}

// ---------------------------------------------------------------------------
// Memory rows

export function getMemory(id: string): MemoryRow | undefined {
  return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
}

export function memoriesInFamily(family: string | null): MemoryRow[] {
  // family null (unattributed observation) → compare against all active memories.
  if (family === null) {
    return db.prepare(`SELECT * FROM memories WHERE status = 'active'`).all() as MemoryRow[];
  }
  return db
    .prepare(`SELECT * FROM memories WHERE status = 'active' AND (repo_family = ? OR repo_family IS NULL)`)
    .all(family) as MemoryRow[];
}

export function createMemory(o: ObservationRow): MemoryRow {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO memories
      (id, claim, kind, repo, repo_family, strength, evidence_count, people_count,
       contradiction_count, last_reinforced_at, status, embedding, retrieval_keys, max_source_weight)
    VALUES
      (@id, @claim, @kind, @repo, @repo_family, @strength, 1, 1, 0, @now, 'active', @embedding, @retrieval_keys, @max_source_weight)
  `).run({
    id,
    claim: o.claim,
    kind: o.kind,
    repo: o.repo,
    repo_family: o.repo_family,
    strength: 0,
    now,
    embedding: o.embedding,
    retrieval_keys: o.retrieval_keys,
    max_source_weight: o.source_weight,
  });
  db.prepare(`UPDATE observations SET memory_id = ? WHERE id = ?`).run(id, o.id);
  invalidateVectorCache();
  return getMemory(id)!;
}

export function updateMemory(id: string, fields: Partial<MemoryRow>): void {
  const keys = Object.keys(fields).filter((k) => k !== "id");
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE memories SET ${setClause}, updated_at = unixepoch() WHERE id = @id`).run({
    id,
    ...fields,
  });
  invalidateVectorCache();
}

export function attachObservation(memoryId: string, observationId: string): void {
  db.prepare(`UPDATE observations SET memory_id = ? WHERE id = ?`).run(memoryId, observationId);
}

// Distinct people who produced attached observations. People are approximated by
// (source, session_id) for sessions and by source for corpus rows — the eval
// only needs "independent origins", not real identities. Never below 1.
export function recomputePeopleCount(memoryId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT (source || ':' || COALESCE(session_id, id))) AS n
       FROM observations WHERE memory_id = ?`,
    )
    .get(memoryId) as { n: number };
  return Math.max(1, row.n || 1);
}

export function evidenceCount(memoryId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE memory_id = ?`).get(memoryId) as { n: number };
  return row.n || 0;
}

// Union of retrieval keys across attached observations (deduped, capped).
export function unionRetrievalKeys(memoryId: string): string[] {
  const rows = db
    .prepare(`SELECT retrieval_keys FROM observations WHERE memory_id = ? AND retrieval_keys IS NOT NULL`)
    .all(memoryId) as Array<{ retrieval_keys: string }>;
  const set = new Set<string>();
  for (const r of rows) {
    try {
      for (const k of JSON.parse(r.retrieval_keys) as string[]) set.add(k);
    } catch {
      /* skip */
    }
  }
  return [...set].slice(0, 40);
}

// ---------------------------------------------------------------------------
// In-process vector cache — search reads vectors from here, not SQLite BLOBs,
// to hit the <300ms target. Invalidated on any write; rebuilt lazily.

interface CachedVec {
  id: string;
  vec: Float32Array;
}
let _memVecCache: CachedVec[] | null = null;

export function invalidateVectorCache(): void {
  _memVecCache = null;
}

export function memoryVectors(): CachedVec[] {
  if (_memVecCache) return _memVecCache;
  const rows = db
    .prepare(`SELECT id, embedding FROM memories WHERE status = 'active' AND embedding IS NOT NULL`)
    .all() as Array<{ id: string; embedding: Buffer }>;
  _memVecCache = rows.map((r) => ({ id: r.id, vec: blobToVec(r.embedding) }));
  return _memVecCache;
}

export function activeMemoryRows(): MemoryRow[] {
  return db.prepare(`SELECT * FROM memories WHERE status = 'active'`).all() as MemoryRow[];
}

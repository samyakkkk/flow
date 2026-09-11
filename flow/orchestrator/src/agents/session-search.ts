// session-search.ts — semantic search over agent sessions ("find that session
// where we fixed the nginx DNS thing"). Each session gets a compact SEARCH DOC
// (title + repo/branch + user prompts + the last agent conclusion) embedded
// through the gateway's shared model (embed.ts → POST /v1/embed) into the
// agent_sessions row itself (search_text, embedding, embedded_at — migration 15).
//
// Docs are (re)embedded off the hot path by a periodic sweep: a session is
// pending when it has no vector yet or its row moved since the last embed
// (updated_at advances on every status transition, so new turns re-embed on
// the next sweep). Query time is pure read: cosine over the stored BLOBs plus
// a lexical-overlap boost — and when the query vector is unavailable (model
// still loading, gateway down) search degrades to lexical-only rather than
// going silent, mirroring memory search's best-effort posture.
//
// The transcript reader is INJECTED (same pattern and reason as
// memory/trigger.ts): runtime.ts owns the transcript store and wires us up at
// its module load, and tests feed synthetic transcripts.

import db from "../db.js";
import { blobToVec, cosine, embedText as gatewayEmbed, vecToBlob } from "../embed.js";
import { stripPreamble, type SlimEvent } from "../memory/slim.js";

export type Embedder = (text: string) => Promise<Float32Array | null>;
let _embedder: Embedder = gatewayEmbed;
export function setEmbedder(fn: Embedder): void {
  _embedder = fn;
}

type TranscriptReader = (id: string) => SlimEvent[];
let _readTranscript: TranscriptReader = () => [];
export function setSessionTranscriptReader(fn: TranscriptReader): void {
  _readTranscript = fn;
}

// ---------------------------------------------------------------------------
// Search doc

const DOC_CAP = 4000; // ~1k tokens — well inside the embedding model's window
const PROMPT_CAP = 500;
const CONCLUSION_TAIL = 600;

// The doc favors what a user remembers a session BY: their own prompts, then
// the closing agent message (the "what happened" summary). Tool noise and
// mid-turn chatter never make it in.
export function buildSearchText(meta: { title?: string | null; repo?: string | null }, events: SlimEvent[]): string {
  const prompts: string[] = [];
  let branch = "";
  let agentBuf = "";
  let lastConclusion = "";
  for (const e of events) {
    if (e.kind === "created") {
      const d = (e.data ?? {}) as { branch?: string };
      if (d.branch) branch = d.branch;
    } else if (e.kind === "user_prompt") {
      if (agentBuf.trim()) lastConclusion = agentBuf.trim();
      agentBuf = "";
      const d = (e.data ?? {}) as { text?: string };
      const t = stripPreamble(d.text || "").trim();
      if (t) prompts.push(t.length > PROMPT_CAP ? t.slice(0, PROMPT_CAP) + "…" : t);
    } else if (e.kind === "update") {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const u = ((d.update ?? d) as Record<string, unknown>) ?? {};
      if (u.sessionUpdate === "agent_message_chunk") {
        agentBuf += (u.content as { text?: string } | undefined)?.text || "";
      }
    }
  }
  if (agentBuf.trim()) lastConclusion = agentBuf.trim();

  const parts = [meta.title ?? "", [meta.repo ?? "", branch].filter(Boolean).join(" "), ...prompts];
  if (lastConclusion) {
    parts.push(lastConclusion.length > CONCLUSION_TAIL ? "…" + lastConclusion.slice(-CONCLUSION_TAIL) : lastConclusion);
  }
  let doc = parts.filter(Boolean).join("\n").trim();
  if (doc.length > DOC_CAP) {
    // Keep both ends: the title+first prompts define the task, the tail holds
    // the conclusion.
    doc = doc.slice(0, DOC_CAP / 2) + "\n…\n" + doc.slice(-DOC_CAP / 2);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Embed sweep — keeps agent_sessions vectors converged with the transcripts

// Statements are prepared lazily: agent_sessions is created at runtime.ts
// module load, AFTER this module first evaluates (same hazard as trigger.ts).
function pendingSessions(limit: number): Array<{ id: string }> {
  return db
    .prepare(
      `SELECT id FROM agent_sessions
       WHERE embedding IS NULL OR embedded_at IS NULL OR updated_at > embedded_at
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as Array<{ id: string }>;
}

// Recompute one session's doc + vector. "skipped" = nothing new to embed
// (doc unchanged, or session has no content); "failed" = embedder unavailable —
// embedded_at stays NULL so the next sweep retries.
export async function embedSessionNow(id: string): Promise<"embedded" | "skipped" | "failed"> {
  const row = db
    .prepare(`SELECT id, title, repo, search_text, embedding IS NOT NULL AS has_vec FROM agent_sessions WHERE id = ?`)
    .get(id) as { id: string; title: string | null; repo: string | null; search_text: string | null; has_vec: number } | undefined;
  if (!row) return "failed";

  const doc = buildSearchText({ title: row.title, repo: row.repo }, _readTranscript(id));
  const now = Date.now();
  if (!doc) {
    // Empty session — stamp it so the sweep stops revisiting until it changes.
    db.prepare(`UPDATE agent_sessions SET embedded_at = ? WHERE id = ?`).run(now, id);
    return "skipped";
  }
  if (doc === row.search_text && row.has_vec) {
    // Row moved (status flip) but content didn't — restamp, skip the model call.
    db.prepare(`UPDATE agent_sessions SET embedded_at = ? WHERE id = ?`).run(now, id);
    return "skipped";
  }

  const vec = await _embedder(doc);
  if (!vec) {
    // Store the doc anyway — lexical search works meanwhile; embedded_at stays
    // NULL so the vector is retried next sweep.
    db.prepare(`UPDATE agent_sessions SET search_text = ? WHERE id = ?`).run(doc, id);
    return "failed";
  }
  db.prepare(`UPDATE agent_sessions SET search_text = ?, embedding = ?, embedded_at = ? WHERE id = ?`).run(
    doc,
    vecToBlob(vec),
    now,
    id
  );
  return "embedded";
}

let _sweeping = false;
export async function sweepSessionEmbeddings(limit = 50): Promise<number> {
  if (_sweeping) return 0;
  _sweeping = true;
  let embedded = 0;
  try {
    for (const r of pendingSessions(limit)) {
      if ((await embedSessionNow(r.id)) === "embedded") embedded++;
    }
  } finally {
    _sweeping = false;
  }
  return embedded;
}

const SWEEP_INTERVAL_MS = 3 * 60 * 1000;

let _timer: ReturnType<typeof setInterval> | null = null;
export function startSessionEmbedSweep(): void {
  if (_timer || process.env.FLOW_SESSION_SEARCH === "0") return;
  const kick = () => {
    sweepSessionEmbeddings().catch((err) => {
      console.warn(`[session-search] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  // First pass shortly after boot (give the gateway a moment to come up —
  // a not-ready model just means a retry on the next interval).
  const boot = setTimeout(kick, 15_000);
  boot.unref?.();
  _timer = setInterval(kick, SWEEP_INTERVAL_MS);
  _timer.unref?.();
}
export function stopSessionEmbedSweep(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

// ---------------------------------------------------------------------------
// Query

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with",
  "that", "this", "was", "were", "is", "are", "it", "at", "by", "we",
  "where", "when", "what", "session", "sessions", "agent",
]);

export function queryTerms(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    ),
  ];
}

// Fraction of query terms present in the doc — the same cheap keyword-overlap
// boost memory search layers over cosine.
export function lexicalOverlap(terms: string[], text: string): number {
  if (terms.length === 0 || !text) return 0;
  const hay = text.toLowerCase();
  let hit = 0;
  for (const t of terms) if (hay.includes(t)) hit++;
  return hit / terms.length;
}

export function snippetFor(terms: string[], text: string | null): string | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  for (const t of terms) {
    const i = hay.indexOf(t);
    if (i < 0) continue;
    const start = Math.max(0, i - 60);
    const end = Math.min(text.length, i + t.length + 90);
    const head = start > 0 ? "…" : "";
    const tail = end < text.length ? "…" : "";
    return head + text.slice(start, end).replace(/\s+/g, " ").trim() + tail;
  }
  return null;
}

// Vector-only hits below this cosine are noise for Gemma-768 (memory search
// gates at 0.55; session docs are longer/noisier so we sit slightly lower).
const COSINE_FLOOR = 0.45;
const LEX_WEIGHT = 0.3;

export interface SessionSearchHit {
  id: string;
  backend: string;
  repo: string;
  title: string;
  status: string;
  worktree_id: string | null;
  created_at: number;
  updated_at: number;
  score: number;
  snippet: string | null;
}

export async function searchSessions(
  query: string,
  limit = 20
): Promise<{ results: SessionSearchHit[]; semantic: boolean }> {
  const terms = queryTerms(query);
  const qvec = await _embedder(query);

  // Opportunistically converge stragglers while someone is actually searching
  // (fire-and-forget; the guard in sweepSessionEmbeddings dedupes overlaps).
  void sweepSessionEmbeddings().catch(() => {});

  const rows = db
    .prepare(
      `SELECT id, backend, repo, title, status, worktree_id, created_at, updated_at, search_text, embedding
       FROM agent_sessions`
    )
    .all() as Array<{
    id: string;
    backend: string;
    repo: string;
    title: string;
    status: string;
    worktree_id: string | null;
    created_at: number;
    updated_at: number;
    search_text: string | null;
    embedding: Buffer | null;
  }>;

  const scored = rows
    .map((r) => {
      const text = r.search_text || r.title || "";
      const cos = qvec && r.embedding ? cosine(qvec, blobToVec(r.embedding)) : 0;
      const lex = lexicalOverlap(terms, text);
      return { r, cos, lex, score: qvec ? cos + LEX_WEIGHT * lex : lex };
    })
    .filter((x) => (x.cos >= COSINE_FLOOR ? true : x.lex > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    semantic: Boolean(qvec),
    results: scored.map(({ r, score }) => ({
      id: r.id,
      backend: r.backend,
      repo: r.repo,
      title: r.title,
      status: r.status,
      worktree_id: r.worktree_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      score: Math.round(score * 1000) / 1000,
      snippet: snippetFor(terms, r.search_text),
    })),
  };
}

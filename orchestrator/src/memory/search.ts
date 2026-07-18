// search.ts — retrieval for search_memory. Eval-calibrated ranking:
//
//   HARD GATE on repo_family mismatch — drop, never downweight. (null family on
//     either side = match-all.)
//   score = cosine
//         + 0.15 * retrieval_keys_overlap
//         + 0.10 * file_mention_overlap
//         + 0.08 * same_repo_exact
//   SILENCE GATE: drop results under ~0.55 cosine UNLESS they are an FTS5 exact
//     hit. FTS candidates are ALWAYS eligible (identifiers/error strings are the
//     reliable path); vector-only candidates must clear the cosine floor.
//   Merge FTS5 + vector candidates before ranking.
//
// Returns terse lines. Also searches the corpus (slack/linear/meeting FTS) and
// labels each result's source. Vectors come from the in-process cache.

import db from "../db.js";
import { cosine, blobToVec } from "../embed.js";
import { getEmbedder, memoryVectors, type MemoryRow } from "./store.js";
import { repoFamily, familyMatches } from "./repo-family.js";
import { strengthTier } from "./strength.js";
import { searchCorpus } from "../corpus.js";

export const COSINE_FLOOR = 0.55;

export interface MemoryHit {
  id: string;
  claim: string;
  kind: string;
  strengthTier: string;
  source: "memory";
  score: number;
  cosine: number;
  ftsHit: boolean;
}

export interface CorpusHit {
  id: string;
  text: string;
  source: string; // slack | linear | meeting
}

export interface SearchResult {
  memories: MemoryHit[];
  corpus: CorpusHit[];
  durationMs: number;
}

// Filler words a keyword search must ignore. The point (per the grep analogy):
// a model searching memory keys on meaningful strings, not whole sentences — so
// a natural-language query like "…images ON a landing page" must NOT match a
// memory merely because both contain "on". Without this, common-token FTS hits
// bypass the silence gate and every query returns noise. This is NOT about
// negation — "not"/"no" are dropped here because FTS never carries meaning;
// the agent reads the claim text to see whether a memory says always vs never.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "get", "gets", "got", "had", "has", "have",
  "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "no", "not", "of",
  "on", "or", "our", "out", "over", "so", "than", "that", "the", "their", "them",
  "then", "there", "they", "this", "to", "up", "us", "was", "we", "were", "what",
  "when", "where", "which", "while", "will", "with", "would", "you", "your", "about",
  "all", "any", "just", "like", "some", "such", "via", "using", "use", "should",
]);

// Meaningful search tokens, grep-style: keep identifiers/paths/error snippets
// (anything with a code char) at any length; keep plain words that aren't filler;
// drop everything else. Lowercased for matching.
export function meaningfulTokens(query: string): string[] {
  const raw = query.match(/[A-Za-z0-9_./:-]+/g) ?? [];
  const out: string[] = [];
  for (const t of raw) {
    const lower = t.toLowerCase();
    const hasCodeChar = /[_./:-]/.test(t) || /\d/.test(t);
    if (hasCodeChar) { out.push(lower); continue; }
    if (lower.length >= 2 && !STOPWORDS.has(lower)) out.push(lower);
  }
  return out;
}

// Escape meaningful tokens for FTS5 MATCH: quote each so punctuation-heavy
// identifiers/error snippets don't blow up the parser. Empty → no FTS (and thus
// no keyword bypass of the silence gate — a filler-only query stays silent).
function ftsQuery(query: string): string {
  const quoted = meaningfulTokens(query).map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(" OR ");
}

function overlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bl = b.map((x) => x.toLowerCase());
  const setB = new Set(bl);
  let hit = 0;
  for (const x of a) if (setB.has(x.toLowerCase())) hit++;
  return hit / a.length;
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface SearchInput {
  query: string;
  repo?: string | null;
  limit?: number;
}

export async function searchMemory(input: SearchInput): Promise<SearchResult> {
  const t0 = Date.now();
  const limit = Math.max(1, Math.min(50, input.limit ?? 8));
  const queryFamily = repoFamily(input.repo);
  const queryTokens = meaningfulTokens(input.query);

  // --- FTS candidate ids (always eligible past the silence gate) ---
  const ftsIds = new Set<string>();
  const match = ftsQuery(input.query);
  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT o.id AS id FROM observations_fts fts
           JOIN observations o ON o.rowid = fts.rowid
           WHERE observations_fts MATCH ? ORDER BY rank LIMIT 100`,
        )
        .all(match) as Array<{ id: string }>;
      // FTS is over observations; map to their memory_id.
      const obsIds = rows.map((r) => r.id);
      if (obsIds.length) {
        const placeholders = obsIds.map(() => "?").join(",");
        const memRows = db
          .prepare(`SELECT DISTINCT memory_id FROM observations WHERE id IN (${placeholders}) AND memory_id IS NOT NULL`)
          .all(...obsIds) as Array<{ memory_id: string }>;
        for (const m of memRows) ftsIds.add(m.memory_id);
      }
    } catch {
      /* FTS parse error → no FTS candidates, vectors still run */
    }
  }

  // --- Vector candidates from the in-process cache ---
  const qvec = await getEmbedder()(input.query);
  const cosById = new Map<string, number>();
  if (qvec) {
    for (const { id, vec } of memoryVectors()) {
      cosById.set(id, cosine(qvec, vec));
    }
  }

  // Merge candidate ids: everything with a cosine + every FTS hit.
  const candidateIds = new Set<string>([...cosById.keys(), ...ftsIds]);
  if (candidateIds.size === 0) {
    return { memories: [], corpus: corpusHits(input.query, limit), durationMs: Date.now() - t0 };
  }

  const placeholders = [...candidateIds].map(() => "?").join(",");
  const memRows = db
    .prepare(`SELECT * FROM memories WHERE status = 'active' AND id IN (${placeholders})`)
    .all(...candidateIds) as MemoryRow[];

  const hits: MemoryHit[] = [];
  for (const m of memRows) {
    // HARD family gate — drop, don't downweight.
    if (!familyMatches(queryFamily, m.repo_family)) continue;

    const cos = cosById.get(m.id) ?? 0;
    const isFts = ftsIds.has(m.id);
    // Silence gate: vector-only candidates must clear the cosine floor; FTS
    // exact hits bypass it.
    if (!isFts && cos < COSINE_FLOOR) continue;

    const keys = parseJsonArray(m.retrieval_keys);
    const keyOverlap = overlap(queryTokens, keys);
    const files = keys.filter((k) => k.includes("/") || k.includes("."));
    const fileOverlap = overlap(queryTokens, files);
    const sameRepoExact = input.repo && m.repo && input.repo.toLowerCase() === m.repo.toLowerCase() ? 1 : 0;

    const score = cos + 0.15 * keyOverlap + 0.1 * fileOverlap + 0.08 * sameRepoExact;
    hits.push({
      id: m.id,
      claim: m.claim,
      kind: m.kind,
      strengthTier: strengthTier(m.strength),
      source: "memory",
      score,
      cosine: cos,
      ftsHit: isFts,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return {
    memories: hits.slice(0, limit),
    corpus: corpusHits(input.query, limit),
    durationMs: Date.now() - t0,
  };
}

// Batch search: run several queries in one call, reusing the single-query core
// per query so ranking/gating logic is never forked. Results are grouped and
// kept in REQUEST ORDER. Concurrency is bounded — each query is a full FTS +
// vector pass, so a small pool keeps a batch from monopolizing the event loop.
export const SEARCH_MEMORY_MAX_BATCH = 10;
const BATCH_CONCURRENCY = 4;

export interface BatchSearchInput {
  queries: string[];
  repo?: string | null;
  limit?: number;
}

export interface SearchGroup {
  query: string;
  result: SearchResult;
}

export interface BatchSearchResult {
  groups: SearchGroup[];
  durationMs: number;
}

export async function searchMemoryBatch(input: BatchSearchInput): Promise<BatchSearchResult> {
  const t0 = Date.now();
  const queries = input.queries;
  const groups: SearchGroup[] = new Array(queries.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, queries.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= queries.length) return;
      const result = await searchMemory({ query: queries[i], repo: input.repo, limit: input.limit });
      groups[i] = { query: queries[i], result };
    }
  });
  await Promise.all(workers);
  return { groups, durationMs: Date.now() - t0 };
}

function corpusHits(query: string, limit: number): CorpusHit[] {
  const match = ftsQuery(query);
  if (!match) return [];
  try {
    const rows = searchCorpus(match, undefined, limit) as Array<{ id: string; text?: string; source: string }>;
    return rows.map((r) => ({ id: r.id, text: String(r.text ?? ""), source: r.source }));
  } catch {
    return [];
  }
}

// Render terse lines for the model. One line per hit: claim, kind, tier, source, id.
export function renderSearchResult(res: SearchResult): string {
  const lines: string[] = [];
  if (res.memories.length === 0 && res.corpus.length === 0) {
    return "(no memories match — try symptoms, identifiers, or file paths)";
  }
  if (res.memories.length) {
    lines.push("MEMORY:");
    for (const m of res.memories) {
      lines.push(`- ${m.claim} [${m.kind}/${m.strengthTier}] (memory ${m.id})`);
    }
  }
  if (res.corpus.length) {
    lines.push("CORPUS:");
    for (const c of res.corpus) {
      const t = c.text.replace(/\s+/g, " ").trim();
      lines.push(`- ${t.length > 180 ? t.slice(0, 179) + "…" : t} [${c.source}] (${c.id})`);
    }
  }
  return lines.join("\n");
}

// Batched search render — one labeled section per query, in request order. Each
// section is exactly the single-query render (same format), so a batched call
// reads as several single results stacked under their query headers.
export function renderBatchSearchResult(res: BatchSearchResult): string {
  return res.groups
    .map((g, i) => `=== q${i + 1}: ${g.query} ===\n${renderSearchResult(g.result)}`)
    .join("\n\n");
}

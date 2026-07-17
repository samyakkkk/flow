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

// Escape a free-text query for FTS5 MATCH: quote each token so punctuation-heavy
// identifiers/error snippets don't blow up the FTS parser. Empty → no FTS.
function ftsQuery(query: string): string {
  const tokens = query.match(/[A-Za-z0-9_./:-]+/g) ?? [];
  const quoted = tokens.filter((t) => t.length >= 2).map((t) => `"${t.replace(/"/g, '""')}"`);
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
  const queryTokens = (input.query.match(/[A-Za-z0-9_./:-]+/g) ?? []).map((t) => t.toLowerCase());

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

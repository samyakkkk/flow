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
import { itemsAnchoredToNode } from "./anchors.js";

export const COSINE_FLOOR = 0.55;

// Node-scoped + type filters parsed out of the query string (Section E). A
// caller can write `node:svc:users type:memory hmac` and get memories anchored
// to svc:users matching "hmac"; the tokens are stripped before FTS/embedding so
// they don't pollute the meaningful-token match. `node` / `type` params take
// precedence over the in-query tokens when both are given.
export type SearchTypeFilter = "memory" | "ticket" | "thread";
const TYPE_FILTERS = new Set<SearchTypeFilter>(["memory", "ticket", "thread"]);

export interface ParsedQuery {
  query: string; // query with node:/type: tokens removed
  node: string | null;
  type: SearchTypeFilter | null;
}

// `node:` values are graph node ids which themselves contain colons
// (api:dashboard:GET /agents), so we capture the rest of that whitespace-
// delimited token, not just up to the next colon.
export function parseSearchTokens(raw: string): ParsedQuery {
  let node: string | null = null;
  let type: SearchTypeFilter | null = null;
  const kept: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    if (!tok) continue;
    if (tok.startsWith("node:") && tok.length > 5) {
      node = tok.slice(5);
      continue;
    }
    if (tok.startsWith("type:") && tok.length > 5) {
      const t = tok.slice(5).toLowerCase();
      if (TYPE_FILTERS.has(t as SearchTypeFilter)) {
        type = t as SearchTypeFilter;
        continue;
      }
    }
    kept.push(tok);
  }
  return { query: kept.join(" ").trim(), node, type };
}

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
  // Node-scoped filter (Section E). Also parseable from a `node:` token in the
  // query; the explicit param wins. Restricts hits to items anchored to the node.
  node?: string | null;
  // Type filter: memory | ticket | thread. Also parseable from `type:`.
  type?: SearchTypeFilter | null;
}

export async function searchMemory(input: SearchInput): Promise<SearchResult> {
  const t0 = Date.now();
  const limit = Math.max(1, Math.min(50, input.limit ?? 8));

  // Pull node:/type: out of the query string; explicit params override.
  const parsed = parseSearchTokens(input.query);
  const effectiveQuery = parsed.query;
  const node = input.node ?? parsed.node;
  const type = input.type ?? parsed.type;

  const queryFamily = repoFamily(input.repo);
  const queryTokens = meaningfulTokens(effectiveQuery);

  // Node scope: the ids anchored to the node, partitioned by item kind. Used to
  // (a) restrict the memory candidate set and (b) scope corpus hits.
  const nodeScope = node ? nodeScopeIds(node) : null;
  // Empty query under a node scope is legitimate ("everything on this node") —
  // the "+N more" line is exactly that. Fall through with empty tokens; the
  // node filter carries the selection.

  // Node scope excludes the memory pass entirely when the type filter asks for
  // tickets/threads only.
  const wantMemories = !type || type === "memory";
  const wantCorpus = !type || type === "ticket" || type === "thread";

  // --- FTS candidate ids (always eligible past the silence gate) ---
  const ftsIds = new Set<string>();
  const match = ftsQuery(effectiveQuery);
  if (wantMemories && match) {
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
  const qvec = effectiveQuery ? await getEmbedder()(effectiveQuery) : null;
  const cosById = new Map<string, number>();
  if (wantMemories && qvec) {
    for (const { id, vec } of memoryVectors()) {
      cosById.set(id, cosine(qvec, vec));
    }
  }

  // Node-scoped, no keyword: the anchored memory set IS the candidate set (the
  // "+N more" line's query). Seed candidates from the node scope so an empty
  // query still returns the node's memories, strength-ranked.
  const nodeMemoryIds = nodeScope ? new Set(nodeScope.memoryIds) : null;

  // Merge candidate ids: everything with a cosine + every FTS hit (+ node
  // memories when node-scoped so an empty query still surfaces them).
  const candidateIds = new Set<string>([...cosById.keys(), ...ftsIds]);
  if (nodeMemoryIds && effectiveQuery === "") for (const id of nodeMemoryIds) candidateIds.add(id);

  const corpus = wantCorpus ? corpusHits(effectiveQuery, limit, nodeScope, type) : [];
  if (candidateIds.size === 0 || !wantMemories) {
    return { memories: [], corpus, durationMs: Date.now() - t0 };
  }

  const placeholders = [...candidateIds].map(() => "?").join(",");
  const memRows = db
    .prepare(`SELECT * FROM memories WHERE status = 'active' AND id IN (${placeholders})`)
    .all(...candidateIds) as MemoryRow[];

  // Empty query = no meaningful tokens → nothing is an FTS "exact hit" and the
  // cosine floor would silence everything. Under a node scope that's wrong: the
  // anchored set is the intended answer. Track it so the gate lets it through.
  const emptyNodeScope = nodeMemoryIds !== null && effectiveQuery === "";

  const hits: MemoryHit[] = [];
  for (const m of memRows) {
    // Node scope: drop memories not anchored to the node.
    if (nodeMemoryIds && !nodeMemoryIds.has(m.id)) continue;

    // HARD family gate — drop, don't downweight.
    if (!familyMatches(queryFamily, m.repo_family)) continue;

    const cos = cosById.get(m.id) ?? 0;
    const isFts = ftsIds.has(m.id);
    // Silence gate: vector-only candidates must clear the cosine floor; FTS
    // exact hits bypass it. An empty node-scoped query bypasses (the anchor IS
    // the selection).
    if (!emptyNodeScope && !isFts && cos < COSINE_FLOOR) continue;

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
    corpus,
    durationMs: Date.now() - t0,
  };
}

// Ids anchored to a node, split by item kind. memoryIds scope the memory pass;
// observationIds scope corpus hits (a corpus observation anchored to the node
// points back to its linear/slack row).
interface NodeScope {
  memoryIds: string[];
  observationIds: string[];
}
function nodeScopeIds(nodeId: string): NodeScope {
  const rows = itemsAnchoredToNode(nodeId);
  return {
    memoryIds: rows.filter((r) => r.item_type === "memory").map((r) => r.item_id),
    observationIds: rows.filter((r) => r.item_type === "observation").map((r) => r.item_id),
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

// type filter → corpus source. ticket = linear, thread = slack. When node-scoped
// the corpus is restricted to rows whose derived observation is anchored to the
// node; an empty query under a node scope returns those rows directly.
function corpusHits(
  query: string,
  limit: number,
  nodeScope: NodeScope | null = null,
  type: SearchTypeFilter | null = null,
): CorpusHit[] {
  const source = type === "ticket" ? "linear" : type === "thread" ? "slack" : undefined;

  // Node-scoped: surface only corpus rows reachable from observations anchored
  // to the node. We already have the anchored observation ids; read their source
  // rows directly (keyword still narrows when present, but the anchor is the
  // primary filter). Kept simple: return the anchored corpus observations' own
  // claim text (the corpus row body) as hits.
  if (nodeScope) {
    if (nodeScope.observationIds.length === 0) return [];
    const ph = nodeScope.observationIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, source, claim FROM observations
         WHERE id IN (${ph}) AND source IN ('slack','linear','meeting')
         ${source ? "AND source = ?" : ""} LIMIT ?`,
      )
      .all(...nodeScope.observationIds, ...(source ? [source] : []), limit) as Array<{
      id: string;
      source: string;
      claim: string;
    }>;
    const tokens = meaningfulTokens(query);
    return rows
      .filter((r) => tokens.length === 0 || tokens.some((t) => r.claim.toLowerCase().includes(t)))
      .map((r) => ({ id: r.id, text: r.claim, source: r.source }));
  }

  const match = ftsQuery(query);
  if (!match) return [];
  try {
    const rows = searchCorpus(match, source, limit) as Array<{ id: string; text?: string; source: string }>;
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

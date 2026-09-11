// search.ts — retrieval for search_knowledge. Eval-calibrated ranking:
//
//   REPO AFFINITY IS RANK, NEVER A GATE (Samyak, 2026-07-19). The project is
//     the trust boundary — one flow.db per project — and every memory in it is
//     eligible from any repo's session. Same repo ranks first, same family
//     next; nothing is invisible. (Supersedes the eval-era repo_family hard
//     gate, which predates the meaningful-tokens FTS fix that closed the
//     actual noise hole.)
//   score = cosine
//         + 0.15 * retrieval_keys_overlap
//         + 0.10 * file_mention_overlap
//         + 0.08 * same_repo_exact
//         + 0.04 * same_family (sibling repo, e.g. acme-backend from acme-frontend)
//   SILENCE GATE: vector-only candidates under ~0.55 cosine don't count as
//     confident hits — FTS5 exact hits always do (identifiers/error strings are
//     the reliable path). The gate marks rather than mutes (Samyak, 2026-07-27):
//     when fewer than FLOOR_FALLBACK_HITS confident hits survive, the top
//     below-floor candidates surface anyway, flagged `distant`, so retrieval
//     degrades to best-effort instead of silence.
//   Merge FTS5 + vector candidates before ranking.
//
// Returns terse lines. Also searches the corpus (slack/linear/meeting FTS) and
// labels each result's source. Vectors come from the in-process cache.

import db from "../db.js";
import { parseSearchTokens, meaningfulTokens, type SearchTypeFilter } from "./search-query.js";
export { parseSearchTokens, meaningfulTokens, type SearchTypeFilter, type ParsedQuery } from "./search-query.js";
import { cosine, blobToVec } from "../embed.js";
import { getEmbedder, memoryVectors, type MemoryRow } from "./store.js";
import { repoFamily } from "./repo-family.js";
import { strengthTier } from "./strength.js";
import { searchCorpus, searchSlackArchive } from "../corpus.js";
import { itemsAnchoredToNode } from "./anchors.js";

export const COSINE_FLOOR = 0.55;

// When the gate leaves fewer confident hits than this, the best below-floor
// candidates fill the gap (marked distant) — the caller always sees the top
// few closest memories when any exist at all.
export const FLOOR_FALLBACK_HITS = 3;

export interface MemoryHit {
  id: string;
  claim: string;
  kind: string;
  strengthTier: string;
  source: "memory";
  score: number;
  cosine: number;
  ftsHit: boolean;
  // True when this hit is a below-floor fallback: no FTS match and cosine under
  // COSINE_FLOOR. Rendered as a "distant" tag so the agent can weigh it.
  distant: boolean;
}

export interface CorpusHit {
  id: string;
  text: string;
  source: string; // slack | linear | meeting
  permalink?: string;
  channel?: string;
  ts?: string;
  channel_name?: string;
  user_id?: string;
  thread_ts?: string;
}

export interface SearchResult {
  memories: MemoryHit[];
  corpus: CorpusHit[];
  durationMs: number;
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

  // Slack channel/chronological reads need no embedding or memory ranking.
  if (parsed.channel || parsed.recent) {
    const rows = !node && (!type || type === "thread")
      ? searchSlackArchive(parsed.channel, ftsQuery(effectiveQuery), !!parsed.recent, limit) : [];
    return { memories: [], corpus: rows.map(r => ({...r, source: "slack"} as CorpusHit)), durationMs: Date.now() - t0 };
  }

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
  // Below-floor candidates kept aside instead of dropped: if the gate leaves
  // fewer than FLOOR_FALLBACK_HITS confident hits, the best of these surface
  // anyway, marked distant — best-effort beats silent emptiness.
  const distantPool: MemoryHit[] = [];
  for (const m of memRows) {
    // Node scope: drop memories not anchored to the node.
    if (nodeMemoryIds && !nodeMemoryIds.has(m.id)) continue;

    const cos = cosById.get(m.id) ?? 0;
    const isFts = ftsIds.has(m.id);
    // Silence gate: vector-only candidates under the cosine floor are marked
    // distant; FTS exact hits pass. An empty node-scoped query passes (the
    // anchor IS the selection).
    const distant = !emptyNodeScope && !isFts && cos < COSINE_FLOOR;

    const keys = parseJsonArray(m.retrieval_keys);
    const keyOverlap = overlap(queryTokens, keys);
    const files = keys.filter((k) => k.includes("/") || k.includes("."));
    const fileOverlap = overlap(queryTokens, files);
    // Repo affinity: rank, never gate — same repo first, family sibling next,
    // rest of the project after. All eligible.
    const sameRepoExact = input.repo && m.repo && input.repo.toLowerCase() === m.repo.toLowerCase() ? 1 : 0;
    const sameFamily = !sameRepoExact && queryFamily && m.repo_family && queryFamily === m.repo_family ? 1 : 0;

    const score = cos + 0.15 * keyOverlap + 0.1 * fileOverlap + 0.08 * sameRepoExact + 0.04 * sameFamily;
    (distant ? distantPool : hits).push({
      id: m.id,
      claim: m.claim,
      kind: m.kind,
      strengthTier: strengthTier(m.strength),
      source: "memory",
      score,
      cosine: cos,
      ftsHit: isFts,
      distant,
    });
  }

  if (hits.length < FLOOR_FALLBACK_HITS && distantPool.length > 0) {
    distantPool.sort((a, b) => b.score - a.score);
    hits.push(...distantPool.slice(0, FLOOR_FALLBACK_HITS - hits.length));
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
export const BATCH_CONCURRENCY = 4;

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
    const rows = searchCorpus(match, source, limit);
    return rows.map((r) => ({ id: r.id, text: String(r.text ?? ""), source: r.source,
      ...(typeof r.permalink === "string" ? { permalink: r.permalink } : {}),
      ...(typeof r.channel === "string" ? { channel: r.channel } : {}),
      ...(typeof r.ts === "string" ? { ts: r.ts } : {}),
    }));
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
      lines.push(`- ${m.claim} [${m.kind}/${m.strengthTier}${m.distant ? ", distant" : ""}] (memory ${m.id})`);
    }
  }
  if (res.corpus.length) {
    lines.push("CORPUS:");
    for (const c of res.corpus) {
      const t = c.text.replace(/\s+/g, " ").trim();
      lines.push(`- ${t.length > (c.source === "slack" ? 1000 : 180) ? t.slice(0, c.source === "slack" ? 999 : 179) + "…" : t} [${c.source}${c.channel_name ? ` #${c.channel_name}` : ""}${c.ts && Number.isFinite(Number(c.ts)) ? ` at:${new Date(Number(c.ts) * 1000).toISOString()}` : ""}${c.user_id ? ` user:${c.user_id}` : ""}${c.channel ? ` channel:${c.channel}` : ""}] (${c.id})${c.permalink ? ` ${c.permalink}` : ""}`);
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

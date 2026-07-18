// find-hits.ts — the orchestrator half of unified find_entity (Section D).
//
// find_entity is a graph verb; memory lives in flow.db. Rather than project
// memories into the graph index (which would require writing to FalkorDB — the
// graph is a rebuildable PROJECTION, and we keep flow.db primary), the gateway
// MERGES memory hits into find_entity results by asking the orchestrator here.
//
// This REUSES search.ts's ranking/gating verbatim (meaningful-token FTS + the
// 0.55 silence gate + family gate) — no forked logic. On top of it we apply the
// TYPE QUOTA: at most MEMORY_HIT_QUOTA memory hits per query UNLESS the caller
// passed a type filter (a typed query is deliberately memory-first, so the quota
// lifts). Batching (qs[]) works because it's just several single calls.
//
// Output is terse typed lines the gateway splices into find_entity's match list:
//   [Memory:gotcha] <headline> (strong) [mem:<id>]

import { searchMemory, type SearchTypeFilter } from "./search.js";

// Max memory hits blended into a single find_entity query's results, unless the
// query carries a type filter. Small on purpose: find_entity is graph-first; a
// few memory hits enrich it without drowning the code nodes.
export const MEMORY_HIT_QUOTA = 3;

const HEADLINE_TRUNC = 100;

export interface MemoryHitLine {
  type: "memory";
  kind: string;
  headline: string;
  tier: string;
  id: string; // mem:<uuid>
  line: string; // the rendered terse line
}

function trunc(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Detect whether a query carries a type: filter — used to decide if the quota
// applies. (search.ts parses and applies it; we only need to know it's present.)
function hasTypeFilter(query: string, explicitType?: SearchTypeFilter | null): boolean {
  if (explicitType) return true;
  return /(^|\s)type:(memory|ticket|thread)(\s|$)/i.test(query);
}

// One query → up to quota terse memory-hit lines (quota lifts when typed).
export async function memoryHitsForQuery(
  query: string,
  repo: string | null,
  opts: { type?: SearchTypeFilter | null; limit?: number } = {},
): Promise<MemoryHitLine[]> {
  const typed = hasTypeFilter(query, opts.type);
  const cap = typed ? (opts.limit ?? 8) : MEMORY_HIT_QUOTA;
  // Ask search for a few extra so the quota slices from a ranked set.
  const res = await searchMemory({ query, repo, type: opts.type ?? null, limit: Math.max(cap, MEMORY_HIT_QUOTA) });
  return res.memories.slice(0, cap).map((m) => {
    const headline = trunc(m.claim, HEADLINE_TRUNC);
    return {
      type: "memory" as const,
      kind: m.kind,
      headline,
      tier: m.strengthTier,
      id: `mem:${m.id}`,
      line: `[Memory:${m.kind}] ${headline} (${m.strengthTier}) [mem:${m.id}]`,
    };
  });
}

export interface QueryHits {
  query: string;
  hits: MemoryHitLine[];
}

// Batch form: several queries, grouped in request order (mirrors search batch).
export async function memoryHitsForQueries(
  queries: string[],
  repo: string | null,
  opts: { type?: SearchTypeFilter | null; limit?: number } = {},
): Promise<QueryHits[]> {
  const out: QueryHits[] = [];
  for (const q of queries) {
    out.push({ query: q, hits: await memoryHitsForQuery(q, repo, opts) });
  }
  return out;
}

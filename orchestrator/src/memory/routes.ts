// routes.ts — HTTP surface for memory v1. The gateway's search_memory verb
// proxies here (the memories + embeddings + FTS all live in the orchestrator's
// flow.db; the gateway is a thin proxy, matching the note/correct_graph shape).
//
//   POST /v1/memory/search  {query, repo?, limit?}   → {lines, memories, corpus, durationMs}
//                           {queries:[…], repo?, limit?} → {lines, groups, durationMs} (batch)
//   GET  /v1/memory/stats                            → counts per source (for orient)
//   GET  /v1/memory/headline/:nodeId                 → node headline index (Section B)
//   GET  /v1/memory/card/:type/:id                   → drill-down card (Section C)
//   POST /v1/memory/hits    {query|queries, repo?, limit?} → find_entity memory
//                                                     merge (Section D): typed
//                                                     terse lines + quota.

import type { FastifyInstance } from "fastify";
import db from "../db.js";
import {
  searchMemory,
  searchMemoryBatch,
  renderSearchResult,
  renderBatchSearchResult,
  SEARCH_MEMORY_MAX_BATCH,
} from "./search.js";
import { getNodeHeadline } from "./headline.js";
import { getCard } from "./cards.js";
import { memoryHitsForQueries, MEMORY_HIT_QUOTA } from "./find-hits.js";

export interface MemoryStats {
  memories: number;
  observations: number;
  bySource: Record<string, number>;
}

export function memoryStats(): MemoryStats {
  const mem = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE status = 'active'`).get() as { n: number };
  const obs = db.prepare(`SELECT COUNT(*) AS n FROM observations`).get() as { n: number };
  const rows = db
    .prepare(`SELECT source, COUNT(*) AS n FROM observations GROUP BY source`)
    .all() as Array<{ source: string; n: number }>;
  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.source] = r.n;
  return { memories: mem.n, observations: obs.n, bySource };
}

export function registerMemoryRoutes(app: FastifyInstance): void {
  app.post<{ Body: { query?: string; queries?: string[]; repo?: string | null; limit?: number } }>(
    "/v1/memory/search",
    async (req, reply) => {
      const b = req.body ?? {};

      // Batch form: {queries:[…]}. Grouped, order-preserved. Empty/blank query
      // strings are dropped before dispatch; the cap is a hard 400 (a clear
      // failure the caller can act on beats a silent truncation).
      if (b.queries !== undefined) {
        if (!Array.isArray(b.queries)) return reply.code(400).send({ error: "queries must be an array of strings" });
        const queries = b.queries.map((q) => String(q ?? "").trim()).filter(Boolean);
        if (queries.length === 0) return reply.code(400).send({ error: "queries is empty" });
        if (queries.length > SEARCH_MEMORY_MAX_BATCH) {
          return reply.code(400).send({ error: `too many queries (${queries.length}); max ${SEARCH_MEMORY_MAX_BATCH} per call` });
        }
        const res = await searchMemoryBatch({ queries, repo: b.repo ?? null, limit: b.limit });
        const total = res.groups.reduce((n, g) => n + g.result.memories.length + g.result.corpus.length, 0);
        console.log(`[memory] batch search ${queries.length}q → ${total} hits in ${res.durationMs}ms`);
        return reply.send({
          lines: renderBatchSearchResult(res),
          groups: res.groups,
          durationMs: res.durationMs,
        });
      }

      if (!b.query || !String(b.query).trim()) {
        return reply.code(400).send({ error: "query is required" });
      }
      const res = await searchMemory({ query: String(b.query), repo: b.repo ?? null, limit: b.limit });
      // Log latency to the activity stream (stdout) — the retrieval budget is
      // <300ms; a slow call is a signal worth seeing.
      console.log(`[memory] search "${String(b.query).slice(0, 60)}" → ${res.memories.length}m/${res.corpus.length}c in ${res.durationMs}ms`);
      return reply.send({
        lines: renderSearchResult(res),
        memories: res.memories,
        corpus: res.corpus,
        durationMs: res.durationMs,
      });
    },
  );

  app.get("/v1/memory/stats", async () => memoryStats());

  // Node headline index (Section B). Served from the in-process cache; the
  // gateway appends `rendered` to get_entity output. Fast (<20ms target): an
  // index-backed read + a cached render.
  app.get<{ Params: { nodeId: string } }>("/v1/memory/headline/:nodeId", async (req) => {
    const nodeId = decodeURIComponent(req.params.nodeId);
    return getNodeHeadline(nodeId);
  });

  // Drill-down cards (Section C). type ∈ {mem,obs,lin,slackthread}. The gateway
  // resolves these id namespaces in get_entity (single + batch ids[]) by calling
  // here — flow.db owns the store, so it's one indexed lookup, no graph hop.
  app.get<{ Params: { type: string; id: string } }>("/v1/memory/card/:type/:id", async (req, reply) => {
    const card = getCard(req.params.type, decodeURIComponent(req.params.id));
    if (card.status === "not_found") return reply.code(404).send(card);
    return card;
  });

  // find_entity memory merge (Section D). Returns typed terse lines the gateway
  // splices into find_entity results, with the type quota already applied.
  app.post<{ Body: { query?: string; queries?: string[]; repo?: string | null; limit?: number } }>(
    "/v1/memory/hits",
    async (req, reply) => {
      const b = req.body ?? {};
      const repo = b.repo ?? null;
      if (b.queries !== undefined) {
        if (!Array.isArray(b.queries)) return reply.code(400).send({ error: "queries must be an array of strings" });
        const queries = b.queries.map((q) => String(q ?? "").trim()).filter(Boolean);
        if (queries.length === 0) return reply.code(400).send({ error: "queries is empty" });
        if (queries.length > SEARCH_MEMORY_MAX_BATCH) {
          return reply.code(400).send({ error: `too many queries (${queries.length}); max ${SEARCH_MEMORY_MAX_BATCH}` });
        }
        const groups = await memoryHitsForQueries(queries, repo, { limit: b.limit });
        return reply.send({ quota: MEMORY_HIT_QUOTA, groups });
      }
      if (!b.query || !String(b.query).trim()) return reply.code(400).send({ error: "query is required" });
      const groups = await memoryHitsForQueries([String(b.query)], repo, { limit: b.limit });
      return reply.send({ quota: MEMORY_HIT_QUOTA, hits: groups[0].hits });
    },
  );
}

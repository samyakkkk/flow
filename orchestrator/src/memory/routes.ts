// routes.ts — HTTP surface for memory v1. The gateway's search_memory verb
// proxies here (the memories + embeddings + FTS all live in the orchestrator's
// flow.db; the gateway is a thin proxy, matching the note/correct_graph shape).
//
//   POST /v1/memory/search  {query, repo?, limit?} → {lines, memories, corpus, durationMs}
//   GET  /v1/memory/stats                          → counts per source (for orient)

import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { searchMemory, renderSearchResult } from "./search.js";

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
  app.post<{ Body: { query?: string; repo?: string | null; limit?: number } }>(
    "/v1/memory/search",
    async (req, reply) => {
      const b = req.body ?? {};
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
}

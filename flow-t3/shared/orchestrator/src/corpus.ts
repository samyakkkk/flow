// corpus.ts — FTS5 corpus search API.
// GET /v1/corpus/search?q=&source=&limit=
// Also exposes insert helpers for use by the action layer.

import type { FastifyInstance } from "fastify";
import db from "./db.js";

type Source = "slack" | "linear" | "meeting";

interface SearchRow {
  id: string;
  text: string;
  source: Source;
  [key: string]: unknown;
}

/**
 * Full-text search across the configured source tables.
 * source param: "slack" | "linear" | "meeting" | omit for all.
 */
export function searchCorpus(q: string, source?: string, limit = 20): SearchRow[] {
  const results: SearchRow[] = [];
  const lim = Math.max(1, Math.min(100, limit));

  const sources: Source[] = source
    ? [source as Source]
    : ["slack", "linear", "meeting"];

  for (const src of sources) {
    if (src === "slack") {
      const rows = db.prepare(`
        SELECT sm.id, sm.text, sm.channel, sm.user_id, sm.ts, sm.permalink
        FROM slack_messages_fts fts
        JOIN slack_messages sm ON sm.rowid = fts.rowid
        WHERE slack_messages_fts MATCH ?
          AND NOT EXISTS (SELECT 1 FROM slack_channels c WHERE c.workspace=sm.workspace AND c.id=sm.channel AND c.is_member=0)
        ORDER BY rank
        LIMIT ?
      `).all(q, lim) as Array<{ id: string; text: string; [key: string]: unknown }>;
      results.push(...rows.map((r) => ({ ...r, source: "slack" as Source })));
    }

    if (src === "linear") {
      const rows = db.prepare(`
        SELECT lt.id, lt.title AS text, lt.identifier, lt.state, lt.url
        FROM linear_tickets_fts fts
        JOIN linear_tickets lt ON lt.rowid = fts.rowid
        WHERE linear_tickets_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(q, lim) as Array<{ id: string; text: string; [key: string]: unknown }>;
      results.push(...rows.map((r) => ({ ...r, source: "linear" as Source })));
    }

    if (src === "meeting") {
      const rows = db.prepare(`
        SELECT ms.id, ms.text, ms.speaker, ms.meeting_id
        FROM meeting_segments_fts fts
        JOIN meeting_segments ms ON ms.rowid = fts.rowid
        WHERE meeting_segments_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(q, lim) as Array<{ id: string; text: string; [key: string]: unknown }>;
      results.push(...rows.map((r) => ({ ...r, source: "meeting" as Source })));
    }
  }

  return results.slice(0, lim);
}

/** Channel-scoped Slack retrieval, including chronological reads without keywords. */
export function searchSlackArchive(channel: string | undefined, match: string, recent: boolean, limit: number): SearchRow[] {
  return (db.prepare(`
    SELECT sm.id,sm.text,sm.channel,sm.user_id,sm.ts,sm.thread_ts,sm.permalink,c.name AS channel_name
    FROM slack_messages sm
    JOIN slack_channels c ON c.workspace=sm.workspace AND c.id=sm.channel AND c.is_member=1
    ${match ? "JOIN slack_messages_fts fts ON fts.rowid=sm.rowid" : ""}
    WHERE (? IS NULL OR sm.channel=? COLLATE NOCASE OR c.name=? COLLATE NOCASE)
    ${match ? "AND slack_messages_fts MATCH ?" : ""}
    ORDER BY ${recent || !match ? "CAST(sm.ts AS REAL) DESC,sm.id" : "rank"} LIMIT ?
  `).all(channel ?? null, channel ?? null, channel?.replace(/^#/, "") ?? null,
    ...(match ? [match] : []), limit) as Array<{id:string;text:string;[key:string]:unknown}>)
    .map(row => ({...row,source:"slack"}));
}

export function registerCorpusRoutes(app: FastifyInstance): void {
  // GET /v1/corpus/search?q=&source=&limit=
  app.get<{
    Querystring: { q?: string; source?: string; limit?: string };
  }>("/v1/corpus/search", async (req, reply) => {
    const { q, source, limit } = req.query;

    if (!q || q.trim().length === 0) {
      return reply.code(400).send({ error: "q is required" });
    }

    try {
      const results = searchCorpus(q, source, limit ? parseInt(limit, 10) : 20);
      return reply.send({ results, count: results.length });
    } catch (err) {
      // FTS5 query parse errors → 400
      return reply.code(400).send({ error: `Search error: ${(err as Error).message}` });
    }
  });
}

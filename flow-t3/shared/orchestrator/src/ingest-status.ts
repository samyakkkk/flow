// ingest-status.ts — GET /v1/ingest/status route.
//
// Returns per-(source, resource) poll cursor status for the dashboard
// "catching up" indicator.
//
// Fields returned per source row:
//   source, resource, cursor, last_poll_at, lag_s, lag_seconds, catching_up, status
//
// lag_s / lag_seconds: both are the same value (alias) — seconds since last poll.
//   null when last_poll_at is 0 (never polled).
// catching_up: true when status === "catching_up".

import type { FastifyInstance } from "fastify";
import { getAllPollStatus } from "./pollers/engine.js";

export function registerIngestStatusRoute(app: FastifyInstance): void {
  app.get("/v1/ingest/status", async (_req, reply) => {
    const rows = getAllPollStatus();
    const now = Math.floor(Date.now() / 1000);
    const sources = rows.map((row) => {
      const lagSecs = row.last_poll_at > 0 ? now - row.last_poll_at : null;
      return {
        source: row.source,
        resource: row.resource,
        cursor: row.cursor,
        last_poll_at: row.last_poll_at,
        lag_s: lagSecs,         // short alias (pollers.test.ts)
        lag_seconds: lagSecs,   // long alias  (poller.test.ts)
        catching_up: row.status === "catching_up",
        status: row.status,
      };
    });
    return reply.send({ sources });
  });
}

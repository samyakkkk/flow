// index-log.ts — durable, queryable trail of indexer lifecycle events.
// Every transition (enqueued, parked, superseded, started, done, failed,
// recovered, watch, removed) lands both on the console (grep for [indexer])
// and in the index_log table, so a self-deployer can reconstruct what the
// indexer did — when the last index ran, what got queued behind what, why a
// job failed — without shell access. Read via GET /v1/index-log.

import { db } from "./db.js";

export type IndexLogEvent =
  | "enqueued"    // job row created (detail: branch, trigger)
  | "parked"      // arrived mid-index; waiting for the running job to finish
  | "superseded"  // parked job replaced by a newer request
  | "started"     // job began executing (detail: branch, backend)
  | "done"        // index succeeded (detail: commit, duration_ms)
  | "failed"      // job failed (detail: error, duration_ms)
  | "recovered"   // boot-time recovery of a stalled/parked job
  | "watch"       // poller branch watch added or changed
  | "removed";    // repo removed; cleanup steps

const insertLog = db.prepare(`
  INSERT INTO index_log (repo, event, job_id, detail)
  VALUES (@repo, @event, @job_id, @detail)
`);

export function indexLog(
  repo: string,
  event: IndexLogEvent,
  jobId?: string,
  detail?: Record<string, unknown>,
): void {
  const detailStr = detail && Object.keys(detail).length > 0 ? JSON.stringify(detail) : null;
  console.log(
    `[indexer] ${event} repo=${repo}${jobId ? ` job=${jobId}` : ""}${detailStr ? ` ${detailStr}` : ""}`,
  );
  // The trail must never take a job down with it.
  try {
    insertLog.run({ repo, event, job_id: jobId ?? null, detail: detailStr });
  } catch (err) {
    console.warn(`[indexer] index_log write failed: ${err}`);
  }
}

export interface IndexLogRow {
  id: number;
  repo: string;
  event: IndexLogEvent;
  job_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: number;
}

// Newest first. repo filter optional; limit capped at 500.
export function readIndexLog(opts: { repo?: string; limit?: number } = {}): IndexLogRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = opts.repo
    ? db
        .prepare(`SELECT * FROM index_log WHERE repo = ? ORDER BY id DESC LIMIT ?`)
        .all(opts.repo, limit)
    : db.prepare(`SELECT * FROM index_log ORDER BY id DESC LIMIT ?`).all(limit);
  return (rows as (Omit<IndexLogRow, "detail"> & { detail: string | null })[]).map((r) => ({
    ...r,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  }));
}

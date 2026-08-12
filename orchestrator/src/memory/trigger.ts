// trigger.ts — decides WHEN to distill a session and runs it off the hot path.
//
// Two triggers (both funnel through queueDistill, which never blocks session ops):
//   1. session → 'closed'    (setStatus in runtime.ts calls onSessionClosed)
//   2. idle sweep            (a timer; a session idle > IDLE_MS with transcript
//                             events past last_distilled_seq gets distilled)
//
// last_distilled_seq (agent_sessions column) is the high-water mark of transcript
// seqs already consumed — so re-distilling only happens when there's NEW content,
// and a crash mid-distill just re-runs next sweep (observations are idempotent
// enough: at worst a duplicate observation the consolidator folds via 'same').

import db from "../db.js";
import { distillSession } from "./distiller.js";
import { distillerEnabled } from "./llm.js";
import type { SlimEvent } from "./slim.js";

export const IDLE_MS = 45 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Injectable transcript reader — avoids a hard import cycle with runtime.ts and
// lets tests feed synthetic transcripts. Set by wireDistillTrigger().
type TranscriptReader = (id: string) => Array<{ seq: number; kind: string; data: unknown }>;
let _readTranscript: TranscriptReader = () => [];
export function setTranscriptReader(fn: TranscriptReader): void {
  _readTranscript = fn;
}

interface SessionMetaRow {
  id: string;
  repo: string | null;
  status: string;
  updated_at: number;
  last_distilled_seq: number | null;
}

// Statements are prepared LAZILY: agent_sessions is created by runtime.ts at
// its module load, which imports this file at its TOP — so the table does not
// exist yet when this module first evaluates. Preparing on first call defers
// until the table is guaranteed present.
function sessionMeta(id: string): SessionMetaRow | undefined {
  return db
    .prepare(`SELECT id, repo, status, updated_at, last_distilled_seq FROM agent_sessions WHERE id = ?`)
    .get(id) as SessionMetaRow | undefined;
}

function setDistilledSeq(seq: number, id: string): void {
  db.prepare(`UPDATE agent_sessions SET last_distilled_seq = ? WHERE id = ?`).run(seq, id);
}

// Run one distill for a session if it has new events. Non-throwing. Returns
// whether it actually distilled (for tests).
export async function maybeDistill(id: string, branch: string | null = null): Promise<boolean> {
  if (!distillerEnabled()) return false;
  const meta = sessionMeta(id);
  if (!meta) return false;

  const events = _readTranscript(id);
  if (events.length === 0) return false;
  const maxSeq = events[events.length - 1].seq;
  const since = meta.last_distilled_seq ?? 0;
  if (maxSeq <= since) return false; // nothing new since last distill

  const slimEvents: SlimEvent[] = events.map((e) => ({ kind: e.kind, data: e.data }));
  let result: { ran: boolean; reason?: string };
  try {
    result = await distillSession({ sessionId: id, repo: meta.repo, branch, events: slimEvents });
  } catch (err) {
    console.warn(`[memory] distill failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  // Do NOT advance the high-water mark on a transient LLM/transport failure —
  // distillSession swallows those (returns {ran:false, reason:'llm-error…'}
  // rather than throwing), and advancing here would permanently mark the
  // session distilled so a later sweep (once the LLM is back) never retries it,
  // silently losing the session's content from the brain.
  if (!result.ran && result.reason?.startsWith("llm-error")) {
    console.warn(`[memory] distill deferred for ${id}: ${result.reason} (will retry on the next idle sweep)`);
    return false;
  }
  // Advance even on a zero-observation run that actually ran (or an
  // empty-transcript) — that content was consumed; re-reading yields nothing new.
  setDistilledSeq(maxSeq, id);
  return result.ran;
}

// Fire-and-forget: queue a distill without blocking the caller (setStatus).
export function queueDistill(id: string, branch: string | null = null): void {
  if (!distillerEnabled()) return;
  setImmediate(() => {
    void maybeDistill(id, branch);
  });
}

// Trigger 1: called from setStatus when a session becomes 'closed'.
export function onSessionClosed(id: string, branch: string | null = null): void {
  queueDistill(id, branch);
}

// Trigger 2: idle sweep. A session that's been idle past IDLE_MS with new
// transcript content gets distilled. Runs on an interval; also callable directly.
export async function idleSweep(now = Date.now()): Promise<number> {
  if (!distillerEnabled()) return 0;
  // agent_sessions.updated_at is MILLISECONDS (runtime.ts writes Date.now()).
  // The cutoff must be too — a /1000 here once made the comparison always
  // false, so the sweep silently matched zero sessions and the distiller
  // never fired on live deployments.
  const cutoff = now - IDLE_MS;
  const rows = db
    .prepare(
      `SELECT id FROM agent_sessions
       WHERE status IN ('idle','error','closed') AND updated_at <= ?`,
    )
    .all(cutoff) as Array<{ id: string }>;
  let ran = 0;
  for (const r of rows) {
    if (await maybeDistill(r.id)) ran++;
  }
  return ran;
}

let _timer: ReturnType<typeof setInterval> | null = null;
export function startIdleSweep(): void {
  if (_timer || process.env.FLOW_DISTILLER === "0") return;
  _timer = setInterval(() => {
    void idleSweep();
  }, SWEEP_INTERVAL_MS);
  _timer.unref?.();
}
export function stopIdleSweep(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

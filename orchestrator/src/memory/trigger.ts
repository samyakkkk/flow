// Five-minute checkpoints for changed sessions, plus immediate closure capture.
// Durable jobs freeze full history and the new-event range before model work.
import db from "../db.js";
import { distillerEnabled } from "./llm.js";
import { createCheckpoint, pendingCheckpoint, runCheckpoint, type TranscriptEvent } from "./checkpoint.js";

export const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
// Kept for existing callers; checkpoints no longer require 45 minutes idle.
export const IDLE_MS = CHECKPOINT_INTERVAL_MS;
type TranscriptReader = (id: string) => TranscriptEvent[];
let _readTranscript: TranscriptReader = () => [];
export function setTranscriptReader(fn: TranscriptReader): void { _readTranscript = fn; }

function checkpointFor(id: string, branch: string | null) {
  const pending = pendingCheckpoint(id);
  if (pending) return pending;
  const meta = db.prepare("SELECT repo, last_distilled_seq FROM agent_sessions WHERE id = ?")
    .get(id) as { repo: string | null; last_distilled_seq: number | null } | undefined;
  if (!meta) return;
  const events = _readTranscript(id);
  const created = events.find((e) => e.kind === "created")?.data as { branch?: string } | undefined;
  return createCheckpoint(id, meta.last_distilled_seq ?? 0, {
    repo: meta.repo, branch: branch ?? created?.branch ?? null, events,
  });
}

export async function maybeDistill(id: string, branch: string | null = null): Promise<boolean> {
  if (!distillerEnabled()) return false;
  const job = checkpointFor(id, branch);
  return job ? runCheckpoint(job) : false;
}

export function queueDistill(id: string, branch: string | null = null): void {
  if (!distillerEnabled()) return;
  // Persist synchronously, before yielding to the background callback.
  try {
    const job = checkpointFor(id, branch);
    if (job) setImmediate(() => { void runCheckpoint(job).catch(() => {}); });
  } catch (err) {
    console.warn(`[memory] could not queue checkpoint for ${id}: ${err instanceof Error ? err.name : "error"}`);
  }
}
export function onSessionClosed(id: string, branch: string | null = null): void { queueDistill(id, branch); }

let sweeping = false;
// Name preserved for runtime integration. Includes active sessions, regardless
// of updated_at, so continuous conversation cannot postpone extraction forever.
export async function idleSweep(_now = Date.now()): Promise<number> {
  if (!distillerEnabled() || sweeping) return 0;
  sweeping = true;
  try {
    // The timer supplies the cadence; do not gate on completion time (a slow
    // extraction would otherwise make the next tick skip and double the gap).
    // checkpointFor checks the sequence watermark before scheduling model work.
    const rows = db.prepare("SELECT id FROM agent_sessions").all() as Array<{ id: string }>;
    let ran = 0;
    for (const row of rows) if (await maybeDistill(row.id)) ran++;
    return ran;
  } finally { sweeping = false; }
}
let timer: ReturnType<typeof setInterval> | null = null;
export function startIdleSweep(): void {
  if (timer || !distillerEnabled()) return;
  const sweep = () => { void idleSweep().catch((err) => console.warn(`[memory] checkpoint sweep failed: ${err instanceof Error ? err.name : "error"}`)); };
  timer = setInterval(sweep, CHECKPOINT_INTERVAL_MS);
  timer.unref?.();
  // Recover pending jobs immediately after runtime finishes initializing.
  setImmediate(sweep);
}
export function stopIdleSweep(): void { if (timer) clearInterval(timer); timer = null; }

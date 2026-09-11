// Durable, bounded session extraction. Full transcript context is frozen with
// the job; only evidence after since_seq can reinforce memories. Each applied
// observation is a transaction/receipt, so partial batches safely resume.
import { randomUUID } from "node:crypto";
import db from "../db.js";
import { buildCheckpointPrompt } from "./prompt.js";
import { extractArrayOrNull, validateObservation, type RawObservation } from "./parse.js";
import { callLlm, distillerModel } from "./llm.js";
import { insertObservation, rawToNewObservation } from "./store.js";
import { consolidateObservation, type Judge } from "./consolidate.js";
import { haikuJudge } from "./judge.js";
import { sweepMemories } from "./maintenance.js";
import { rebuildOrientDocsFor } from "./orient-doc.js";

export interface TranscriptEvent { seq: number; kind: string; data: unknown }
interface Input { repo: string | null; branch: string | null; events: TranscriptEvent[]; memories?: { id: string; text: string }[] }
type Change = RawObservation & { action?: "add" | "update" | "remove"; memory_id?: string };
export interface CheckpointJob {
  id: string; session_id: string; since_seq: number; through_seq: number;
  input_json: string; output_json: string | null; status: string;
}

export function pendingCheckpoint(sessionId: string): CheckpointJob | undefined {
  return db.prepare("SELECT * FROM memory_distill_jobs WHERE session_id = ? AND status = 'pending'")
    .get(sessionId) as CheckpointJob | undefined;
}

export function createCheckpoint(sessionId: string, since: number, input: Input): CheckpointJob | undefined {
  const pending = pendingCheckpoint(sessionId);
  if (pending) return pending;
  const events = input.events.filter((e) => Number.isSafeInteger(e.seq) && e.seq > 0).sort((a, b) => a.seq - b.seq);
  const through = events.at(-1)?.seq ?? 0;
  if (through <= since) return;
  if (sessionId.startsWith("t3-")) {
    // Keep new events verbatim. Earlier transcript is context; existing notes
    // carry durable decisions forward without rereading the entire conversation.
    const meaningful = events.filter(e => {
      if (e.kind === "user_prompt" || e.kind === "error") return true;
      const data = e.data as { sessionUpdate?: string; status?: string } | null;
      return data?.sessionUpdate === "agent_message_chunk" ||
        (data?.sessionUpdate === "tool_call_update" && data.status === "failed");
    });
    const earlier = meaningful.filter(e => e.seq <= since).slice(-8);
    const fresh = meaningful.filter(e => e.seq > since);
    input = { ...input, events: [...earlier, ...fresh], memories: db.prepare(`SELECT id, claim AS text FROM observations WHERE session_id = ? AND id NOT IN (SELECT observation_id FROM chat_memory_retired) ORDER BY created_at, id`).all(sessionId) as { id: string; text: string }[] };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO memory_distill_jobs
    (id, session_id, since_seq, through_seq, input_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, sessionId, since, through, JSON.stringify({ ...input, events: input.memories ? input.events : events }), Date.now());
  return pendingCheckpoint(sessionId);
}

// Structural events cannot be cited as proof of a new claim.
function substantive(e: TranscriptEvent): boolean {
  if (e.kind === "user_prompt" || e.kind === "error") return true;
  if (e.kind !== "update") return false;
  const data = e.data as Record<string, unknown> | null;
  const update = (data?.update ?? data) as Record<string, unknown> | null;
  return ["agent_message_chunk", "tool_call", "tool_call_update"].includes(String(update?.sessionUpdate));
}

export function validateCheckpointOutput(reply: string, job: CheckpointJob, events: TranscriptEvent[]): RawObservation[] {
  const array = extractArrayOrNull(reply);
  if (!array || array.length > 5) throw new Error("Invalid extraction: expected an array of at most five observations");
  const ids = new Set(events.filter(substantive).map((e) => e.seq));
  return array.map((item) => {
    const obs = validateObservation(item);
    const seqs = obs?.evidence_seqs;
    if (!obs || !seqs?.length || !seqs.every((seq) => Number.isSafeInteger(seq) && ids.has(seq))
      || !seqs.some((seq) => seq > job.since_seq && seq <= job.through_seq)) {
      throw new Error("Invalid extraction: every claim must cite real evidence including a new event");
    }
    return { ...obs, evidence_seqs: [...new Set(seqs)] };
  });
}

// Serializes closure, periodic ticks and direct retries in this orchestrator.
// Persistent pending jobs recover on the next sweep after a process restart.
const running = new Map<string, Promise<boolean>>();
export function runCheckpoint(job: CheckpointJob, judge: Judge = haikuJudge): Promise<boolean> {
  const existing = running.get(job.session_id);
  if (existing) return existing;
  const run = processCheckpoint(job, judge).finally(() => running.delete(job.session_id));
  running.set(job.session_id, run);
  return run;
}

async function processCheckpoint(job: CheckpointJob, judge: Judge): Promise<boolean> {
  // Another caller may have held this job object while it completed.
  const current = db.prepare("SELECT * FROM memory_distill_jobs WHERE id = ?").get(job.id) as CheckpointJob | undefined;
  if (!current || current.status !== "pending") return false;
  job = current;
  const input = JSON.parse(job.input_json) as Input;
  db.prepare("UPDATE memory_distill_jobs SET attempts = attempts + 1, error = NULL WHERE id = ?").run(job.id);
  try {
    let raws: Change[];
    if (job.output_json !== null) {
      raws = JSON.parse(job.output_json) as Change[];
    } else {
      const hasNewContent = input.events.some((e) => e.seq > job.since_seq && substantive(e));
      const reply = hasNewContent ? await callLlm(
        buildCheckpointPrompt(input.events.map((e) => JSON.stringify(e)).join("\n"), job.since_seq, job.through_seq, input.memories),
        { tier: job.session_id.startsWith("t3-") ? "fast" : "smart", feature: "distiller", model: distillerModel() },
      ) : "[]";
      if (input.memories) {
        const changes = extractArrayOrNull(reply);
        if (!changes || changes.length > 5) throw Error("Invalid memory changes");
        const targets = new Set<string>();
        raws = changes.map(value => {
          const change = value as Change;
          if (!change || ![undefined, "add", "update", "remove"].includes(change.action)) throw Error("Invalid memory action");
          if (change.action === "update" || change.action === "remove") {
            const previous = input.memories!.find(m => m.id === change.memory_id);
            if (!previous || targets.has(previous.id)) throw Error("Invalid or repeated memory target");
            targets.add(previous.id);
            // Validate removal evidence using the previous claim, but never
            // insert a fabricated observation for the removal itself.
            if (change.action === "remove") {
              const raw = validateCheckpointOutput(JSON.stringify([{ claim: previous.text, kind: "decision", source: "user_stated", context: {}, retrieval_keys: [], evidence_seqs: change.evidence_seqs }]), job, input.events)[0]!;
              return { ...raw, action: "remove", memory_id: previous.id };
            }
          }
          const raw = validateCheckpointOutput(JSON.stringify([change]), job, input.events)[0]!;
          return { ...raw, action: change.action ?? "add", ...(change.action === "update" ? { memory_id: change.memory_id } : {}) };
        });
        const known = new Set(input.memories.map(m => m.text.trim().toLowerCase().replace(/\s+/g, " ")));
        raws = raws.filter(raw => {
          if (raw.action !== "add") return true;
          const key = raw.claim.trim().toLowerCase().replace(/\s+/g, " ");
          if (known.has(key)) return false;
          known.add(key); return true;
        });
      } else raws = validateCheckpointOutput(reply, job, input.events);
      // Freeze the extraction before applying any item. A retry never asks the
      // model to paraphrase the same pending claims into different identities.
      db.prepare("UPDATE memory_distill_jobs SET output_json = ? WHERE id = ?").run(JSON.stringify(raws), job.id);
    }
    for (const [index, raw] of raws.entries()) {
      if (raw.action === "remove") continue;
      const obs = await insertObservation({
        ...rawToNewObservation(raw, { repo: input.repo, branch: input.branch, session_id: job.session_id }),
        id: `distill:${job.id}:${index}`,
        source_id: `distill:${job.id}:${index}`,
        // Earlier citations are preserved in output_json for context, but are
        // not counted again as fresh evidence in this checkpoint.
        evidence_seqs: raw.evidence_seqs!.filter((seq) => seq > job.since_seq),
      });
      await consolidateObservation(obs, judge);
    }
    // Individual observation receipts and this final cursor/status transaction
    // make both partial batches and retries after completion repeat-safe.
    db.transaction(() => {
      for (const raw of raws) if (raw.memory_id) {
        // History remains available to the brain; only the current chat view
        // retires the obsolete note. Scope targets to this session again.
        db.prepare(`INSERT OR IGNORE INTO chat_memory_retired (observation_id, checkpoint_id) SELECT id, ? FROM observations WHERE id = ? AND session_id = ?`).run(job.id, raw.memory_id, job.session_id);
      }
      db.prepare(`UPDATE agent_sessions SET last_distilled_seq = MAX(COALESCE(last_distilled_seq, 0), ?) WHERE id = ?`)
        .run(job.through_seq, job.session_id);
      db.prepare("UPDATE memory_distill_jobs SET status = 'done', completed_at = ?, error = NULL WHERE id = ?")
        .run(Date.now(), job.id);
    })();
  } catch (err) {
    // Do not persist model responses/error bodies, which may repeat source text.
    db.prepare("UPDATE memory_distill_jobs SET error = ? WHERE id = ?").run("Checkpoint failed; retry pending", job.id);
    console.warn(`[memory] checkpoint ${job.id} failed (${err instanceof Error ? err.name : "error"}); will retry`);
    return false;
  }
  // Derived views are recoverable and must not roll back a completed checkpoint.
  try { sweepMemories(); rebuildOrientDocsFor(input.repo); }
  catch { console.warn(`[memory] checkpoint ${job.id}: derived view refresh failed`); }
  return true;
}

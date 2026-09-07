// consolidate.ts — fold a new observation into the memories store.
//
// Eval-calibrated banding (do not re-litigate):
//   cosine(obs, memory) < T_LO (0.50)  → CREATE a new memory. No auto-merge.
//   cosine >= T_LO                      → ask an LLM judge (claude-haiku-4-5)
//        which returns exactly one of: same | new | refines | contradicts.
//   There is NO "auto-same" high band: contradictions embed MORE similarly than
//   rewordings, so a naive 0.85 auto-merge band merged 87% of contradictions in
//   the eval. Every above-threshold decision goes through the judge (98.6%
//   action accuracy).
//
// Actions:
//   same        → attach, evidence++, people recompute, last_reinforced=now
//   refines     → attach + replace canonical claim with the refined text
//   contradicts → attach as counter-evidence, contradiction_count++ (strength
//                 penalty applied by recomputeStrength)
//   new         → create a new memory
//
// The judge is INJECTED so tests use a deterministic fake and never call an LLM.

import db from "../db.js";
import { cosine, blobToVec } from "../embed.js";
import {
  type ObservationRow,
  type MemoryRow,
  createMemory,
  activeMemoryRows,
  updateMemory,
  attachObservation,
  recomputePeopleCount,
  evidenceCount,
  unionRetrievalKeys,
  getMemory,
} from "./store.js";
import { computeStrength, strongerWeight } from "./strength.js";
import { resolveMemoryAnchors } from "./anchors.js";
import { invalidateHeadlineCache } from "./headline.js";

export const T_LO = 0.5;

export type JudgeVerdict = "same" | "new" | "refines" | "contradicts";

// A judge compares two claims and returns exactly one verdict. The default
// (haiku-backed) lives in judge.ts; tests pass a fake.
export type Judge = (a: MemoryRow, b: ObservationRow) => Promise<{ verdict: JudgeVerdict; refinedClaim?: string }>;

export interface ConsolidateResult {
  action: JudgeVerdict;
  memoryId: string;
  created: boolean;
}

// Best cosine match among candidate memories for this observation's embedding.
function bestMatch(obs: ObservationRow, candidates: MemoryRow[]): { mem: MemoryRow; sim: number } | null {
  if (!obs.embedding) return null;
  const q = blobToVec(obs.embedding);
  let best: { mem: MemoryRow; sim: number } | null = null;
  for (const m of candidates) {
    if (!m.embedding) continue;
    const sim = cosine(q, blobToVec(m.embedding));
    if (!best || sim > best.sim) best = { mem: m, sim };
  }
  return best;
}

// Recompute + persist a memory's derived fields (people, evidence, keys,
// strength) after an observation attaches.
export function recomputeStrength(memoryId: string): MemoryRow {
  const mem = getMemory(memoryId)!;
  const people = recomputePeopleCount(memoryId);
  const evidence = evidenceCount(memoryId);
  const strength = computeStrength({
    people_count: people,
    evidence_count: evidence,
    max_source_weight: mem.max_source_weight,
    contradiction_count: mem.contradiction_count,
    last_reinforced_at: mem.last_reinforced_at ?? mem.created_at,
  });
  updateMemory(memoryId, {
    people_count: people,
    evidence_count: evidence,
    strength,
    retrieval_keys: JSON.stringify(unionRetrievalKeys(memoryId)),
  });
  return getMemory(memoryId)!;
}

export async function consolidateObservation(obs: ObservationRow, judge: Judge): Promise<ConsolidateResult> {
  // A committed attachment is the durable application receipt. Never rerun its
  // judge or reinforcement (including after a checkpoint process crashes).
  const applied = () => (db.prepare("SELECT memory_id FROM observations WHERE id = ?").get(obs.id) as { memory_id: string | null } | undefined)?.memory_id;
  const previous = applied();
  if (previous) return { action: "same", memoryId: previous, created: false };

  const match = bestMatch(obs, activeMemoryRows());
  const decision = !match || match.sim < T_LO
    ? { verdict: "new" as const }
    : await judge(match.mem, obs);

  // All SQL effects of applying one observation are atomic. No asynchronous
  // model calls or graph writes may run inside this SQLite transaction.
  const result = db.transaction((): ConsolidateResult => {
    const already = applied();
    if (already) return { action: "same", memoryId: already, created: false };
    const target = match ? getMemory(match.mem.id) : undefined;
    if (decision.verdict === "new" || !target) {
      const mem = createMemory(obs);
      recomputeStrength(mem.id);
      return { action: "new", memoryId: mem.id, created: true };
    }

    const cited = db.prepare("SELECT session_id, event_seq FROM observation_events WHERE observation_id = ?")
      .all(obs.id) as Array<{ session_id: string; event_seq: number }>;
    const hasNewEvidence = cited.length === 0 || cited.some((e) => !db.prepare(`
      SELECT 1 FROM observation_events e JOIN observations o ON o.id = e.observation_id
      WHERE o.memory_id = ? AND e.session_id = ? AND e.event_seq = ? LIMIT 1
    `).get(target.id, e.session_id, e.event_seq));
    attachObservation(target.id, obs.id);
    if (hasNewEvidence) {
      const fields: Partial<MemoryRow> = {
        max_source_weight: strongerWeight(target.max_source_weight, obs.source_weight),
        last_reinforced_at: Math.floor(Date.now() / 1000),
      };
      if (decision.verdict === "contradicts") fields.contradiction_count = target.contradiction_count + 1;
      if (decision.verdict === "refines" && decision.refinedClaim?.trim()) fields.claim = decision.refinedClaim.trim();
      updateMemory(target.id, fields);
    }
    recomputeStrength(target.id);
    return { action: decision.verdict, memoryId: target.id, created: false };
  })();
  await anchorAfterConsolidate(result.memoryId);
  return result;
}

// Resolve a memory's anchors and invalidate the headline cache for any node it
// now touches. Non-throwing: anchoring is best-effort enrichment — a graph
// hiccup must never sink consolidation (the memory is already stored). The
// resolve itself is idempotent, so a missed pass is recovered on the next
// reinforcement or a reindex re-resolve.
async function anchorAfterConsolidate(memoryId: string): Promise<void> {
  try {
    const nodeIds = await resolveMemoryAnchors(memoryId);
    for (const id of nodeIds) invalidateHeadlineCache(id);
  } catch {
    /* best-effort; item falls back to repo-level */
  }
}

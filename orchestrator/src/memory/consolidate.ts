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

import { cosine, blobToVec } from "../embed.js";
import {
  type ObservationRow,
  type MemoryRow,
  createMemory,
  memoriesInFamily,
  updateMemory,
  attachObservation,
  recomputePeopleCount,
  evidenceCount,
  unionRetrievalKeys,
  getMemory,
} from "./store.js";
import { computeStrength, strongerWeight } from "./strength.js";

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
  const candidates = memoriesInFamily(obs.repo_family);
  const match = bestMatch(obs, candidates);

  // No candidate at all, or below T_LO → brand-new memory.
  if (!match || match.sim < T_LO) {
    const mem = createMemory(obs);
    recomputeStrength(mem.id);
    return { action: "new", memoryId: mem.id, created: true };
  }

  // At/above T_LO → the judge decides.
  const { verdict, refinedClaim } = await judge(match.mem, obs);

  if (verdict === "new") {
    const mem = createMemory(obs);
    recomputeStrength(mem.id);
    return { action: "new", memoryId: mem.id, created: true };
  }

  // same | refines | contradicts all ATTACH the observation to the matched memory.
  attachObservation(match.mem.id, obs.id);
  const now = Math.floor(Date.now() / 1000);
  const nextWeight = strongerWeight(match.mem.max_source_weight, obs.source_weight);

  if (verdict === "contradicts") {
    updateMemory(match.mem.id, {
      contradiction_count: match.mem.contradiction_count + 1,
      max_source_weight: nextWeight,
      last_reinforced_at: now,
    });
  } else {
    // same or refines: reinforce.
    const fields: Partial<MemoryRow> = { max_source_weight: nextWeight, last_reinforced_at: now };
    if (verdict === "refines" && refinedClaim && refinedClaim.trim()) {
      fields.claim = refinedClaim.trim();
    }
    updateMemory(match.mem.id, fields);
  }

  recomputeStrength(match.mem.id);
  return { action: verdict, memoryId: match.mem.id, created: false };
}

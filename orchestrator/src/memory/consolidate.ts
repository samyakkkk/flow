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

// How many above-band candidates the judge inspects per observation. Judging
// ONLY the single best cosine match let near-duplicates through: when the best
// match judged "new" (or a slightly-closer unrelated memory outranked the true
// duplicate), the duplicate was never even compared — production accumulated
// 4x copies of the same decision. Bounded at K to cap judge-call cost.
export const TOP_K = 3;

// Top-K cosine matches (all >= minSim) among candidate memories, best first.
export function topMatches(
  obs: ObservationRow,
  candidates: MemoryRow[],
  k = TOP_K,
  minSim = T_LO,
): Array<{ mem: MemoryRow; sim: number }> {
  if (!obs.embedding) return [];
  const q = blobToVec(obs.embedding);
  const scored: Array<{ mem: MemoryRow; sim: number }> = [];
  for (const m of candidates) {
    if (!m.embedding) continue;
    const sim = cosine(q, blobToVec(m.embedding));
    if (sim >= minSim) scored.push({ mem: m, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k);
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
  // Candidates are PROJECT-WIDE, not family-scoped: all repos in a project
  // share memories (Samyak, 2026-07-19), so the same fact learned from two
  // repos merges and strengthens instead of duplicating per family. The T_LO
  // band + judge already own the same/new decision; widening candidates only
  // adds cheap in-process cosine comparisons.
  const matches = topMatches(obs, activeMemoryRows());

  // No candidate at/above T_LO → brand-new memory.
  // Otherwise walk the top-K best-first: the first non-"new" verdict wins.
  // A "new" verdict on the closest match no longer ends the search — the
  // true duplicate is often the SECOND-closest candidate.
  for (const match of matches) {
    const { verdict, refinedClaim } = await judge(match.mem, obs);
    if (verdict === "new") continue;

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
    await anchorAfterConsolidate(match.mem.id);
    return { action: verdict, memoryId: match.mem.id, created: false };
  }

  const mem = createMemory(obs);
  recomputeStrength(mem.id);
  await anchorAfterConsolidate(mem.id);
  return { action: "new", memoryId: mem.id, created: true };
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

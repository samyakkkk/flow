// strength.ts — the ONE place memory strength is computed. Pure, auditable,
// no LLM. A memory's strength is a single REAL in [0, ~1.3] combining:
//
//   people_count   — how many DISTINCT people independently produced evidence.
//                     This DOMINATES: three people saying it once beats one
//                     person saying it three times (independent corroboration
//                     is the strongest durability signal).
//   evidence_count  — total attached observations (repetition; weaker than people).
//   max_source_weight — the strongest provenance any attached observation carries:
//                     error_proven > user_stated > agent_inferred. A single
//                     error-proven fact outranks a pile of agent guesses.
//   recency         — exponential decay on last_reinforced_at. Old, un-reinforced
//                     memories fade; a memory under FLOOR is swept to 'sunk'.
//   contradiction_count — counter-evidence penalty. Contradicted memories lose
//                     strength fast (a contested claim is not durable knowledge).
//
// The bands (T_LO) and judge live in consolidate.ts; this file only scores.

export type SourceWeight = "agent_inferred" | "user_stated" | "error_proven";

const SOURCE_WEIGHT_VALUE: Record<SourceWeight, number> = {
  agent_inferred: 0.15,
  user_stated: 0.45,
  error_proven: 0.6,
};

export function sourceWeightRank(w: string): number {
  return SOURCE_WEIGHT_VALUE[(w as SourceWeight)] ?? 0;
}

// Pick the strongest of two source weights (used when attaching an observation).
export function strongerWeight(a: string, b: string): SourceWeight {
  return sourceWeightRank(a) >= sourceWeightRank(b) ? (a as SourceWeight) : (b as SourceWeight);
}

const HALF_LIFE_DAYS = 45; // reinforcement resets the clock; after ~45d idle, recency halves
const DECAY_LAMBDA = Math.LN2 / (HALF_LIFE_DAYS * 24 * 3600);

// Strength below this floor → the maintenance sweep marks the memory 'sunk'.
export const STRENGTH_FLOOR = 0.2;

export interface StrengthInput {
  people_count: number;
  evidence_count: number;
  max_source_weight: string;
  contradiction_count: number;
  last_reinforced_at: number; // unix seconds
  now?: number; // unix seconds; injectable for tests
}

// recencyFactor in (0, 1]: 1 when just reinforced, halving every HALF_LIFE_DAYS.
export function recencyFactor(lastReinforcedAt: number, now: number): number {
  const ageSec = Math.max(0, now - lastReinforcedAt);
  return Math.exp(-DECAY_LAMBDA * ageSec);
}

export function computeStrength(input: StrengthInput): number {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const people = Math.max(1, input.people_count);
  const evidence = Math.max(1, input.evidence_count);

  // people dominates evidence: log-scaled, but people weighted ~2.2x.
  // 3 people (once each) -> ~0.61 base; 1 person, 3 observations -> ~0.34 base.
  const peopleTerm = 0.55 * Math.log2(1 + people);
  const evidenceTerm = 0.18 * Math.log2(1 + evidence);
  const provenanceTerm = sourceWeightRank(input.max_source_weight);

  const raw = peopleTerm + evidenceTerm + provenanceTerm;

  // Contradiction penalty is multiplicative and steep: each counter-observation
  // roughly halves the surviving strength.
  const contradictionFactor = Math.pow(0.5, Math.max(0, input.contradiction_count));

  const recency = recencyFactor(input.last_reinforced_at, now);

  return raw * contradictionFactor * recency;
}

// Human-facing tier for terse search output.
export function strengthTier(strength: number): "strong" | "medium" | "weak" {
  if (strength >= 0.6) return "strong";
  if (strength >= 0.35) return "medium";
  return "weak";
}

// judge.ts — the consolidation judge (claude-haiku-4-5). Given an existing
// memory's canonical claim and a new observation's claim (both above the T_LO
// cosine band), decide EXACTLY ONE of: same | new | refines | contradicts.
//
// This is the eval-calibrated action classifier (98.6% action accuracy). It is
// wired as the default Judge for consolidateObservation; tests inject a fake
// Judge instead and never reach this code.

import type { Judge } from "./consolidate.js";
import { callLlm, judgeModel } from "./llm.js";

const JUDGE_PROMPT = `You compare two knowledge claims about a codebase and decide their relationship. Output EXACTLY ONE word, nothing else:

- same        — B restates A (same fact, possibly reworded). No new information.
- refines     — B is A made more precise, more correct, or more complete (a strict improvement of the SAME claim). If you pick this, you may also improve the wording.
- contradicts — B asserts something that CANNOT both be true with A. Opposite decisions, negations, reversed conclusions. Be alert: a negation ("we do NOT use X") of A ("we use X") is CONTRADICTS, never same.
- new         — B is about a genuinely different fact; it only happened to sound similar.

Respond with only one of: same | refines | contradicts | new`;

function parseVerdict(reply: string): "same" | "new" | "refines" | "contradicts" {
  const t = reply.toLowerCase();
  // Order matters: check contradicts before "new"/"same" substrings collide.
  if (/\bcontradict/.test(t)) return "contradicts";
  if (/\brefine/.test(t)) return "refines";
  if (/\bsame\b/.test(t)) return "same";
  return "new";
}

export const haikuJudge: Judge = async (a, b) => {
  const prompt =
    `${JUDGE_PROMPT}\n\nA (existing memory): ${a.claim}\n\nB (new observation): ${b.claim}\n\nRelationship:`;
  const reply = await callLlm(prompt, { tier: "fast", feature: "judge", model: judgeModel() });
  return { verdict: parseVerdict(reply) };
};

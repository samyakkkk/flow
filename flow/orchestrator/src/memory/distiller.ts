// Explicit remember and legacy/offline whole-session distillation helpers.
// Live session triggers use checkpoint.ts: full retained transcript context,
// validated event citations, persisted extraction output and incremental ranges.

import { slimTranscript, type SlimEvent } from "./slim.js";
import { buildDistillerPrompt } from "./prompt.js";
import { parseObservations, type RawObservation } from "./parse.js";
import { callLlm, distillerModel, distillerEnabled } from "./llm.js";
import { insertObservation, rawToNewObservation } from "./store.js";
import { consolidateObservation, type Judge } from "./consolidate.js";
import { haikuJudge } from "./judge.js";
import { sweepMemories } from "./maintenance.js";
import { rebuildOrientDocsFor } from "./orient-doc.js";

export interface DistillContext {
  sessionId: string;
  repo: string | null;
  branch: string | null;
  events: SlimEvent[];
  judge?: Judge; // injectable; defaults to haikuJudge
}

export interface DistillOutcome {
  ran: boolean;
  observations: number;
  actions: Record<string, number>; // same|new|refines|contradicts counts
  reason?: string;
}

export async function distillSession(ctx: DistillContext): Promise<DistillOutcome> {
  if (!distillerEnabled()) return { ran: false, observations: 0, actions: {}, reason: "disabled" };

  const slimmed = slimTranscript(ctx.events);
  if (slimmed.trim().length < 40) {
    // Nothing worth a model call — an empty/trivial session.
    return { ran: false, observations: 0, actions: {}, reason: "empty-transcript" };
  }

  const prompt = buildDistillerPrompt(slimmed);
  let reply: string;
  try {
    reply = await callLlm(prompt, { tier: "smart", feature: "distiller", model: distillerModel() });
  } catch (err) {
    return { ran: false, observations: 0, actions: {}, reason: `llm-error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const raws = parseObservations(reply);
  const judge = ctx.judge ?? haikuJudge;
  const actions: Record<string, number> = {};

  for (const raw of raws) {
    const obs = await insertObservation(
      rawToNewObservation(raw, { repo: ctx.repo, branch: ctx.branch, session_id: ctx.sessionId }),
    );
    const res = await consolidateObservation(obs, judge);
    actions[res.action] = (actions[res.action] ?? 0) + 1;
  }

  // Cheap maintenance sweep on completion (recency decay → sink under floor),
  // then refresh the ambient tier — membership may have changed either way.
  sweepMemories();
  rebuildOrientDocsFor(ctx.repo);

  return { ran: true, observations: raws.length, actions };
}

// Active capture — the `remember` verb's write path. The user explicitly said
// "remember this" (or the model judged something worth keeping NOW), so the
// text runs through the SAME pipeline as a session tail: prompt → LLM →
// parse → consolidate, framed as a user prompt. Two deliberate differences
// from distillSession:
//   - source_weight floors to user_stated: the human dictated this.
//   - an explicit "remember" is NEVER lost — if the LLM path fails or
//     extracts nothing, the text is stored verbatim as one observation
//     (claim is FTS-indexed, so it stays retrievable either way).
export interface RememberContext {
  text: string;
  repo: string | null;
  branch: string | null;
  sessionId: string | null;
  judge?: Judge; // injectable; defaults to haikuJudge
}

export async function rememberText(ctx: RememberContext): Promise<DistillOutcome> {
  let raws: RawObservation[] = [];
  if (distillerEnabled()) {
    try {
      const prompt = buildDistillerPrompt(`### USER PROMPT\nRemember this: ${ctx.text}`);
      const reply = await callLlm(prompt, { tier: "smart", feature: "remember", model: distillerModel() });
      raws = parseObservations(reply);
    } catch {
      raws = []; // fall through to the verbatim path
    }
  }
  const verbatim = raws.length === 0;
  if (verbatim) {
    raws = [{ claim: ctx.text, kind: "decision", context: {}, source: "user_stated", retrieval_keys: [], ambient: false }];
  }

  const judge = ctx.judge ?? haikuJudge;
  const actions: Record<string, number> = {};
  for (const raw of raws) {
    const obs = await insertObservation(
      rawToNewObservation(
        { ...raw, source: "user_stated" },
        { repo: ctx.repo, branch: ctx.branch, session_id: ctx.sessionId },
      ),
    );
    const res = await consolidateObservation(obs, judge);
    actions[res.action] = (actions[res.action] ?? 0) + 1;
  }
  sweepMemories();
  rebuildOrientDocsFor(ctx.repo);

  return { ran: true, observations: raws.length, actions, ...(verbatim ? { reason: "verbatim-fallback" } : {}) };
}

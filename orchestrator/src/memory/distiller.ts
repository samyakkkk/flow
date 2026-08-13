// distiller.ts — the session-end write path. NON-BLOCKING: the runtime queues a
// distill job; it never delays session ops. One LLM call slims + extracts
// durable observations, each is consolidated into the memories store, then a
// cheap decay sweep runs.
//
// Pipeline: transcript events → slim → prompt → claude CLI → parse array →
//   insert observations (embed at write) → consolidate (band + judge) → sweep.
//
// FLOW_DISTILLER=0 disables the whole path. The judge is the default haiku judge
// but is injectable for tests via distillSession({ judge }).

import { slimTranscript, type SlimEvent } from "./slim.js";
import { buildDistillerPrompt } from "./prompt.js";
import { parseObservations, type RawObservation } from "./parse.js";
import { callLlm, distillerModel, distillerEnabled } from "./llm.js";
import { insertObservation, rawToNewObservation } from "./store.js";
import { consolidateObservation, type Judge } from "./consolidate.js";
import { haikuJudge } from "./judge.js";
import { sweepMemories, dedupeSweep } from "./maintenance.js";
import { rebuildOrientDocsFor } from "./orient-doc.js";
import { queueDocsCompose } from "./docs.js";

export interface DistillContext {
  sessionId: string;
  repo: string | null;
  branch: string | null;
  events: SlimEvent[];
  judge?: Judge; // injectable; defaults to haikuJudge
  // Observations this session already produced across earlier incremental
  // distills — past prompt.BUDGET_PRESSURE_AT the prompt raises the bar.
  priorObservations?: number;
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

  const prompt = buildDistillerPrompt(slimmed, { priorObservations: ctx.priorObservations });
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

  // Cheap maintenance sweep on completion (recency decay → sink under floor).
  // When new observations landed, also resolve a small budget of near-dup
  // pairs — this is how historical duplicates drain without a manual pass.
  sweepMemories();
  if (raws.length > 0) {
    try {
      await dedupeSweep(judge, { maxPairs: 5 });
    } catch {
      /* best-effort; next distill retries */
    }
  }
  rebuildOrientDocsFor(ctx.repo);
  // Living-doc chapters recompose off the hot path; fingerprint gating makes
  // the no-change case free.
  if (raws.length > 0) queueDocsCompose(ctx.repo);

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
  queueDocsCompose(ctx.repo);

  return { ran: true, observations: raws.length, actions, ...(verbatim ? { reason: "verbatim-fallback" } : {}) };
}

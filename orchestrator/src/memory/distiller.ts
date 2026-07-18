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
import { parseObservations } from "./parse.js";
import { callLlm, distillerModel, distillerEnabled } from "./llm.js";
import { insertObservation, rawToNewObservation } from "./store.js";
import { consolidateObservation, type Judge } from "./consolidate.js";
import { haikuJudge } from "./judge.js";
import { sweepMemories } from "./maintenance.js";

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

  // Cheap maintenance sweep on completion (recency decay → sink under floor).
  sweepMemories();

  return { ran: true, observations: raws.length, actions };
}

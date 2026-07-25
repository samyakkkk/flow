// llm.ts — the memory pipeline's seam onto the shared LLM transport layer
// (../llm.ts), used by the distiller (one call per session) and the
// consolidation judge (one call per above-threshold observation).
//
// The transport is INJECTABLE (setLlmTransport) so tests run entirely offline —
// nothing is spawned or fetched. Set FLOW_DISTILLER=0 to hard-disable the
// distiller path.
//
// Models: features ask by TIER (distiller = smart, judge = fast); the shared
// layer maps tier → model per transport (CLI vs HTTP ids differ). The
// DISTILLER_MODEL / DISTILLER_JUDGE_MODEL env overrides pass through verbatim
// when set — whoever sets one owns matching it to the active transport.

import { complete, type LlmCallOpts } from "../llm.js";

// Env override or undefined (undefined = the shared layer's tier default).
export function distillerModel(): string | undefined {
  return process.env.DISTILLER_MODEL || undefined;
}
export function judgeModel(): string | undefined {
  return process.env.DISTILLER_JUDGE_MODEL || undefined;
}

export function distillerEnabled(): boolean {
  return process.env.FLOW_DISTILLER !== "0";
}

// A transport takes a prompt + call opts and returns the model's raw text
// reply. The default is the shared layer; tests inject a stub.
export type LlmTransport = (prompt: string, opts: LlmCallOpts) => Promise<string>;

let _transport: LlmTransport = complete;
export function setLlmTransport(fn: LlmTransport): void {
  _transport = fn;
}
export function callLlm(prompt: string, opts: LlmCallOpts): Promise<string> {
  return _transport(prompt, opts);
}

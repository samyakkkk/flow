// llm.ts — one narrow wrapper around a single-shot `claude -p` CLI call, used by
// the distiller (one call per session) and the consolidation judge (one call
// per above-threshold observation). No tools, JSON output, env-overridable model.
//
// The transport is INJECTABLE (setLlmTransport) so tests run entirely offline —
// no CLI is spawned. Set FLOW_DISTILLER=0 to hard-disable the distiller path.
//
// Real transport: spawn the locally-installed `claude` executable with
//   claude -p "<prompt>" --model <model> --output-format json
// and return the `.result` string from the CLI's JSON envelope.

import { execFile } from "node:child_process";
import { resolveLocalExecutable } from "../agents/runtime.js";

export const DISTILLER_MODEL_DEFAULT = "claude-sonnet-4-6";
export const JUDGE_MODEL_DEFAULT = "claude-haiku-4-5";

export function distillerModel(): string {
  return process.env.DISTILLER_MODEL || DISTILLER_MODEL_DEFAULT;
}
export function judgeModel(): string {
  return process.env.DISTILLER_JUDGE_MODEL || JUDGE_MODEL_DEFAULT;
}

export function distillerEnabled(): boolean {
  return process.env.FLOW_DISTILLER !== "0";
}

// A transport takes a prompt + model and returns the model's raw text reply.
export type LlmTransport = (prompt: string, model: string) => Promise<string>;

// Real CLI transport. Returns the `.result` field of `--output-format json`.
const cliTransport: LlmTransport = async (prompt, model) => {
  const bin = (await resolveLocalExecutable("claude")) ?? "claude";
  return await new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      ["-p", prompt, "--model", model, "--output-format", "json"],
      { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const env = JSON.parse(stdout) as { result?: string };
          resolve(typeof env.result === "string" ? env.result : stdout);
        } catch {
          // Not the JSON envelope — return raw stdout (parser is tolerant).
          resolve(stdout);
        }
      },
    );
  });
};

let _transport: LlmTransport = cliTransport;
export function setLlmTransport(fn: LlmTransport): void {
  _transport = fn;
}
export function callLlm(prompt: string, model: string): Promise<string> {
  return _transport(prompt, model);
}

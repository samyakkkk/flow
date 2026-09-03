// slack-agent/runtime.ts — the seam between Slack plumbing and the answering
// brain. Slack listeners build a RuntimeQuery and render the RuntimeAnswer;
// nothing Slack-specific crosses this boundary, so the runtime can be swapped
// for a customer-specific agent, a webhook, or a direct LLM call later.
//
// FlowRuntime is the default: it feeds the question to the orchestrator's own
// answer-job pipeline (opencode answerer over the knowledge graph + memory).

import { enqueueJob, getJob } from "../opencode.js";
import type { TranscriptTurn as Turn } from "./types.js";
export type { TranscriptTurn, Surface, RuntimeQuery, RuntimeAnswer, AgentRuntime } from "./types.js";
import type { AgentRuntime, RuntimeAnswer, RuntimeQuery } from "./types.js";

interface AnswerPayload {
  answer_md?: string;
  citations?: { kind: string; ref: string }[];
  confidence?: number;
  gaps?: string[];
}

const POLL_MS = 1000;

export class FlowRuntime implements AgentRuntime {
  readonly name = "flow";

  constructor(private answerTimeoutMs = Number(process.env.SLACK_AGENT_ANSWER_TIMEOUT_MS ?? 300_000)) {}

  async ask(query: RuntimeQuery): Promise<RuntimeAnswer> {
    const question = buildQuestion(query);

    query.onStatus?.("Searching the knowledge graph…");
    const { id } = await enqueueJob({ type: "answer", input: { question } });

    const deadline = Date.now() + this.answerTimeoutMs;
    while (Date.now() < deadline) {
      if (query.signal?.aborted) throw new DOMException("aborted", "AbortError");
      await sleep(POLL_MS, query.signal);
      const job = getJob(id);
      if (!job) throw new Error(`answer job ${id} disappeared`);
      if (job.status === "done") {
        const result = (job.result_json ? JSON.parse(job.result_json) : {}) as AnswerPayload;
        return {
          markdown: renderAnswer(result),
          citations: result.citations ?? [],
          confidence: result.confidence,
        };
      }
      if (job.status === "failed") {
        throw new Error(`answer job failed: ${(job.result_json ?? "").slice(0, 300)}`);
      }
    }
    throw new Error(`answer job ${id} timed out after ${Math.round(this.answerTimeoutMs / 1000)}s`);
  }
}

/** Trivial runtime for tests: echoes the prompt back. */
export class EchoRuntime implements AgentRuntime {
  readonly name = "echo";

  async ask(query: RuntimeQuery): Promise<RuntimeAnswer> {
    query.onStatus?.("Echoing…");
    return {
      markdown: `You said: ${query.prompt}\n\n_(echo runtime — ${query.transcript.length} prior turns, surface: ${query.context.surface})_`,
    };
  }
}

export function buildQuestion(query: RuntimeQuery): string {
  const parts: string[] = [];
  if (query.transcript.length > 0) {
    const lines = query.transcript
      .slice(-20)
      .map((t: Turn) => `${t.role === "assistant" ? "Flow" : "User"}: ${t.text}`)
      .join("\n");
    parts.push(`Conversation so far (Slack thread):\n${lines}\n`);
  }
  parts.push(query.prompt);
  return parts.join("\n");
}

export function renderAnswer(result: AnswerPayload): string {
  const answer = result.answer_md?.trim() || "(no answer)";
  const cites = (result.citations ?? []).map((c) => `• ${c.kind}: ${c.ref}`).join("\n");
  const gaps = (result.gaps ?? []).filter(Boolean);
  let out = answer;
  if (cites) out += `\n\n*Sources:*\n${cites}`;
  if (gaps.length > 0) out += `\n\n*Gaps:* ${gaps.join("; ")}`;
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

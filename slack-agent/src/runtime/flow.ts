// runtime/flow.ts — AgentRuntime backed by Flow's ask pipeline.
//
// POST /v1/ask enqueues an "answer" job (opencode answerer agent over the
// knowledge graph + memory); we poll GET /v1/jobs/:id until it settles.
// Thread history is folded into the question because /v1/ask is stateless.

import type { AgentRuntime, RuntimeAnswer, RuntimeQuery } from "./types.js";

interface FlowRuntimeOptions {
  orchestratorUrl: string;
  adminToken: string | undefined;
  answerTimeoutMs: number;
}

interface AnswerPayload {
  answer_md?: string;
  citations?: { kind: string; ref: string }[];
  confidence?: number;
  gaps?: string[];
}

const POLL_MS = 1500;

export class FlowRuntime implements AgentRuntime {
  readonly name = "flow";

  constructor(private opts: FlowRuntimeOptions) {}

  private async api(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.opts.orchestratorUrl}${path}`, {
      ...init,
      signal: signal ?? null,
      headers: {
        "Content-Type": "application/json",
        ...(this.opts.adminToken ? { Authorization: `Bearer ${this.opts.adminToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok && res.status !== 202) {
      throw new Error(`orchestrator ${path} → ${res.status} ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async ask(query: RuntimeQuery): Promise<RuntimeAnswer> {
    const question = buildQuestion(query);

    query.onStatus?.("Asking Flow…");
    const enq = await this.api("/v1/ask", { method: "POST", body: JSON.stringify({ question }) }, query.signal);
    const jobId = enq.id as string | undefined;
    if (!jobId) throw new Error("orchestrator /v1/ask returned no job id");

    query.onStatus?.("Searching the knowledge graph…");
    const deadline = Date.now() + this.opts.answerTimeoutMs;
    while (Date.now() < deadline) {
      if (query.signal?.aborted) throw new DOMException("aborted", "AbortError");
      await sleep(POLL_MS, query.signal);
      const job = await this.api(`/v1/jobs/${jobId}`, {}, query.signal);
      const status = job.status as string;
      if (status === "done") {
        const result = (job.result ?? {}) as AnswerPayload;
        return {
          markdown: renderAnswer(result),
          citations: result.citations ?? [],
          confidence: result.confidence,
        };
      }
      if (status === "failed") {
        throw new Error(`Flow answer job failed: ${JSON.stringify(job.result ?? {}).slice(0, 300)}`);
      }
    }
    throw new Error(`Flow answer job ${jobId} timed out after ${Math.round(this.opts.answerTimeoutMs / 1000)}s`);
  }
}

function buildQuestion(query: RuntimeQuery): string {
  const parts: string[] = [];
  if (query.transcript.length > 0) {
    const lines = query.transcript
      .slice(-20)
      .map((t) => `${t.role === "assistant" ? "Flow" : "User"}: ${t.text}`)
      .join("\n");
    parts.push(`Conversation so far (Slack thread):\n${lines}\n`);
  }
  parts.push(query.prompt);
  return parts.join("\n");
}

function renderAnswer(result: AnswerPayload): string {
  const answer = result.answer_md?.trim() || "(no answer)";
  const cites = (result.citations ?? [])
    .map((c) => `• ${c.kind}: ${c.ref}`)
    .join("\n");
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

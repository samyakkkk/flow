// llmlog.ts — LLM observability. Every live model interaction (classifier
// calls, opencode jobs) is recorded so misclassifications and weird agent runs
// can be debugged after the fact. Never called for fixture/fake test paths.
//
// GET /v1/llmlog?limit=&kind=&ref=  (bearer) — newest first, full prompt/response.

import type { FastifyInstance } from "fastify";
import { createLogger } from "@flow/logger";
import db from "./db.js";

const log = createLogger("llmlog");
const CAP = 16_000; // chars per prompt/response — enough to debug, bounded on disk

const insert = db.prepare(`
  INSERT INTO llm_log (kind, ref, model, attempt, ok, latency_ms, error, prompt, response)
  VALUES (@kind, @ref, @model, @attempt, @ok, @latency_ms, @error, @prompt, @response)
`);

export function logLLM(entry: {
  kind: "classifier" | "opencode_job";
  ref?: string;
  model?: string;
  attempt?: number;
  ok: boolean;
  latencyMs?: number;
  error?: string;
  prompt?: string;
  response?: string;
}): void {
  try {
    insert.run({
      kind: entry.kind,
      ref: entry.ref ?? null,
      model: entry.model ?? null,
      attempt: entry.attempt ?? 1,
      ok: entry.ok ? 1 : 0,
      latency_ms: entry.latencyMs ?? null,
      error: entry.error?.slice(0, 2000) ?? null,
      prompt: entry.prompt?.slice(0, CAP) ?? null,
      response: entry.response?.slice(0, CAP) ?? null,
    });
  } catch (err) {
    // Observability must never break the pipeline it observes.
    log.error("failed to record", { err: err instanceof Error ? err.message : String(err) });
  }
}

export function registerLlmLogRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string; kind?: string; ref?: string } }>(
    "/v1/llmlog",
    async (req, reply) => {
      const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
      const clauses: string[] = [];
      const params: Record<string, string | number> = { limit };
      if (req.query.kind) {
        clauses.push("kind = @kind");
        params.kind = req.query.kind;
      }
      if (req.query.ref) {
        clauses.push("ref = @ref");
        params.ref = req.query.ref;
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM llm_log ${where} ORDER BY id DESC LIMIT @limit`)
        .all(params);
      return reply.send({ rows, count: rows.length });
    }
  );
}

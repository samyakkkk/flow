// fake-opencode.ts — Canned opencode results for tests (FLOW_FAKE_OPENCODE=1).
// Imported dynamically by opencode.ts when env flag is set.
//
// The run() signature now receives (opts, jobId) so simulate_notify can POST
// /v1/notify N times using process.env.ORCHESTRATOR_URL + FLOW_ADMIN_TOKEN.
// simulate_notify is passed as opts.input.simulate_notify (integer).
//
// simulate_notify hook: when an "answer" or "continue" job has input.simulate_notify = N,
// fake-opencode fires N real HTTP POSTs to /v1/notify before returning. This lets
// scenario 10 exercise the budget end-to-end.

import type { JobInput } from "../src/opencode.js";

export async function run(
  opts: JobInput,
  jobId: string
): Promise<{ result: unknown; sessionId: string }> {
  const sessionId = opts.type === "continue" && typeof opts.input.session_id === "string"
    ? opts.input.session_id : `fake-ses-${jobId}`;

  switch (opts.type) {
    case "answer":
    case "continue": {
      const delay = Number(opts.input.simulate_delay_ms ?? 0);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      // simulate_notify: fire N notify calls before returning (test hook for G10 budget)
      const simulateNotify = opts.input.simulate_notify as number | undefined;
      if (simulateNotify && simulateNotify > 0) {
        await fireSimulatedNotifies(jobId, simulateNotify);
      }

      const isContinue = opts.type === "continue";
      const question = isContinue
        ? (opts.input.message as string | undefined) ?? ""
        : (opts.input.question as string | undefined) ?? "";

      const answerMd = isContinue
        ? `**Continued:** I remember you asked: "${question}". The codebase uses TypeScript.`
        : `**Answer:** Here is the answer to: "${question}"\n\nThe codebase uses TypeScript with a monorepo layout.`;

      return {
        result: {
          answer_md: answerMd,
          citations: [
            { kind: "node", ref: "node:Concept:typescript-usage" },
            { kind: "file", ref: "flow/orchestrator/src/index.ts:1" },
          ],
          confidence: 0.88,
          gaps: ["Deployment specifics not yet indexed"],
          session_id: sessionId,
        },
        sessionId,
      };
    }

    case "index_repo": {
      // simulate_delay_ms: hold the job open so tests can observe the per-repo
      // coalescing queue (parked/superseded jobs) while this one "runs".
      const delayMs = opts.input.simulate_delay_ms as number | undefined;
      if (delayMs && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        result: {
          status: "ok",
          nodes_written: 12,
          edges_written: 8,
          repo: opts.input.repo,
          branch: opts.input.branch,
        },
        sessionId,
      };
    }

    case "enrich":
      return {
        result: {
          status: "ok",
          enrichments: 3,
        },
        sessionId,
      };

    case "correct_graph": {
      // Mirrors the real runner's shape: raw text ending in the verdict JSON
      // that resolveFromJobResult parses. Test hook: input.simulate_verdict
      // ("applied" | "rejected") picks the outcome; default applied.
      const verdict = (opts.input.simulate_verdict as string | undefined) ?? "applied";
      const raw = `Verified against the base checkout.\n\n{"verdict": "${verdict}", "summary": "fake-opencode ${verdict} the flag on ${(opts.input.target_ids as string[] | undefined)?.join(", ") ?? "?"}"}`;
      return { result: { status: "ok", raw }, sessionId };
    }

    default:
      return { result: { status: "ok" }, sessionId };
  }
}

// ------------------------------------------------------------------
// Fire N HTTP POSTs to /v1/notify for simulate_notify test hook.
// Uses process.env.ORCHESTRATOR_URL + FLOW_ADMIN_TOKEN (injected by
// run-scenarios.ts into the orchestrator subprocess env).
// ------------------------------------------------------------------

async function fireSimulatedNotifies(jobId: string, count: number): Promise<void> {
  const baseUrl =
    process.env.ORCHESTRATOR_URL ??
    `http://127.0.0.1:${process.env.ORCHESTRATOR_PORT ?? "7500"}`;
  const token = process.env.FLOW_ADMIN_TOKEN ?? "dev-token";

  for (let i = 1; i <= count; i++) {
    try {
      await fetch(`${baseUrl}/v1/notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          job_id: jobId,
          text: `[simulate-notify ${i}/${count}] Progress update from opencode`,
        }),
      });
    } catch (err) {
      // Non-fatal: log and continue so budget logic is still exercised
      console.warn(`[fake-opencode] simulate_notify ${i}/${count} failed:`, err);
    }
  }
}

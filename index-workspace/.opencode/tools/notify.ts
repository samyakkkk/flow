import { tool } from "@opencode-ai/plugin";

// notify — scoped progress-update tool (G10).
//
// Sends a text update back to the Slack thread that spawned this session.
// The destination (channel + thread_ts) is pre-bound by the orchestrator —
// the model cannot choose where the message lands.
//
// Budget enforced server-side:
//   calls 1-2  → delivered to thread
//   call  3    → rejected with an instructive error (returned verbatim so
//                the model can decide whether to push through)
//   calls 4+   → accepted (model sees ok) but flagged in audit
//
// Required env (injected by orchestrator for every real run):
//   ORCHESTRATOR_URL     e.g. http://127.0.0.1:7500
//   FLOW_JOB_TOKEN       per-job scoped bearer token
//   FLOW_JOB_ID          identifies the originating job

const BASE = process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:7500";
const TOKEN = process.env.FLOW_JOB_TOKEN ?? process.env.FLOW_ADMIN_TOKEN ?? "";
const JOB_ID = process.env.FLOW_JOB_ID ?? "";

export const notify = tool({
  description:
    "Send a brief progress update or final summary back to the Slack thread that triggered this task. " +
    "Use sparingly: the first two calls are delivered; a third will be soft-rejected with an error " +
    "message (returned to you) — only push through if something materially changed. " +
    "Do not use this for every step; only for meaningful milestones.",
  args: {
    text: tool.schema
      .string()
      .describe(
        "The update text to post. Keep it brief and actionable, e.g. 'Indexing complete — found 42 services'."
      ),
  },
  async execute(args) {
    if (!JOB_ID) {
      return "Error: FLOW_JOB_ID not set — cannot send notification.";
    }

    const res = await fetch(`${BASE}/v1/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ job_id: JOB_ID, text: args.text }),
    });

    // Return the server response verbatim so pushback errors reach the model
    return res.text();
  },
});

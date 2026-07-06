// drainer.ts — Outbox drainer loop.
//
// Polls the outbox table on a configurable interval (FLOW_DRAIN_MS, default 3000ms).
// For each pending row, dispatches based on action_type:
//   slack_post | dm    → Slack chat.postMessage (SLACK_BOT_TOKEN required)
//   linear_comment     → Linear createComment via real LinearClient
//   linear_ticket_create → Linear createIssue
//   linear_context_update → Linear upsertBotComment
//
// Lifecycle: pending → sent (on success) | failed (error, max 3 retries).
// If credentials for a target are absent, row stays pending (correct behaviour —
// simulators assert on pending rows).

import db from "./db.js";

const MAX_RETRIES = 3;

// ------------------------------------------------------------------
// DB helpers
// ------------------------------------------------------------------

const getPending = db.prepare(`
  SELECT * FROM outbox
  WHERE status = 'pending'
  ORDER BY id ASC
  LIMIT 50
`);

const markSent = db.prepare(`
  UPDATE outbox
  SET status = 'sent', sent_at = unixepoch()
  WHERE id = @id
`);

const markFailed = db.prepare(`
  UPDATE outbox
  SET status = 'failed', payload = @payload
  WHERE id = @id
`);

// We store retry count + error in the payload JSON field
function getRetryCount(row: OutboxRow): number {
  try {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    return typeof p._retry === "number" ? p._retry : 0;
  } catch {
    return 0;
  }
}

function incrementRetry(row: OutboxRow, error: string): string {
  try {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    const retries = (typeof p._retry === "number" ? p._retry : 0) + 1;
    return JSON.stringify({ ...p, _retry: retries, _last_error: error });
  } catch {
    return JSON.stringify({ _retry: 1, _last_error: error });
  }
}

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface OutboxRow {
  id: number;
  event_id: string | null;
  action_type: string;
  payload: string;
  status: string;
  created_at: number;
  sent_at: number | null;
}

// ------------------------------------------------------------------
// Dispatch functions
// ------------------------------------------------------------------

async function dispatchSlackPost(payload: Record<string, unknown>): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) throw new Error("SLACK_BOT_TOKEN not set — row will stay pending");

  const { WebClient } = await import("@slack/web-api");
  const wc = new WebClient(botToken);
  await wc.chat.postMessage({
    channel: (payload.channel as string) ?? "",
    text: (payload.text as string) ?? "",
    thread_ts: payload.thread_ts as string | undefined,
  });
}

async function dispatchLinearComment(payload: Record<string, unknown>): Promise<void> {
  const { createIssue, linearGql } = await import("./adapters/linear.js");

  const ticketId = payload.ticket_id as string;
  const body = payload.body as string;

  await linearGql<unknown>(
    `mutation CreateComment($input: CommentCreateInput!) {
       commentCreate(input: $input) { success }
     }`,
    { input: { issueId: ticketId, body } }
  );
}

async function dispatchLinearCreate(payload: Record<string, unknown>): Promise<void> {
  const { createIssue } = await import("./adapters/linear.js");

  await createIssue({
    teamId: (payload.team_id as string) ?? process.env.LINEAR_DEFAULT_TEAM_ID ?? "",
    title: payload.title as string,
    description: payload.description as string | undefined,
    assigneeId: payload.assignee_id as string | undefined,
  });
}

async function dispatchLinearContextUpdate(payload: Record<string, unknown>): Promise<void> {
  const { upsertBotComment } = await import("./adapters/linear.js");

  const ticketId = payload.ticket_id as string;
  const contextBody = payload.context_body as string;

  await upsertBotComment(ticketId, contextBody);
}

// ------------------------------------------------------------------
// Main drain tick
// ------------------------------------------------------------------

async function drainOnce(): Promise<void> {
  const rows = getPending.all() as OutboxRow[];

  for (const row of rows) {
    const retries = getRetryCount(row);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      markFailed.run({ id: row.id, payload: JSON.stringify({ _error: "invalid JSON" }) });
      continue;
    }

    try {
      switch (row.action_type) {
        case "slack_post":
        case "dm":
          await dispatchSlackPost(payload);
          break;

        case "linear_comment":
          await dispatchLinearComment(payload);
          break;

        case "linear_ticket_create":
          await dispatchLinearCreate(payload);
          break;

        case "linear_context_update":
          await dispatchLinearContextUpdate(payload);
          break;

        default:
          // Unknown action type — mark failed immediately
          throw new Error(`Unknown action_type: ${row.action_type}`);
      }

      markSent.run({ id: row.id });
    } catch (err) {
      const errMsg = String(err);

      // Credential-absent errors: leave pending (do not count as retries)
      if (
        errMsg.includes("not set — row will stay pending") ||
        errMsg.includes("LINEAR_API_KEY not set")
      ) {
        // Stay pending — correct behavior, simulators assert on this
        continue;
      }

      // Real error — increment retry
      const newPayload = incrementRetry(row, errMsg);

      if (retries + 1 >= MAX_RETRIES) {
        markFailed.run({ id: row.id, payload: newPayload });
        console.error(`[drainer] Row ${row.id} (${row.action_type}) failed permanently after ${retries + 1} attempts: ${errMsg}`);
      } else {
        // Update payload with retry info but keep status pending
        db.prepare("UPDATE outbox SET payload = ? WHERE id = ?").run(newPayload, row.id);
        console.warn(`[drainer] Row ${row.id} (${row.action_type}) attempt ${retries + 1} failed: ${errMsg}`);
      }
    }
  }
}

// ------------------------------------------------------------------
// Boot / stop
// ------------------------------------------------------------------

let drainTimer: ReturnType<typeof setInterval> | null = null;

export function startDrainer(): void {
  if (drainTimer) return; // already running

  const intervalMs = parseInt(process.env.FLOW_DRAIN_MS ?? "3000", 10);
  console.log(`[drainer] Starting outbox drainer, interval=${intervalMs}ms`);

  drainTimer = setInterval(() => {
    void drainOnce().catch((err) => console.error("[drainer] Uncaught error:", err));
  }, intervalMs);
}

export function stopDrainer(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

// Export for testing
export { drainOnce };

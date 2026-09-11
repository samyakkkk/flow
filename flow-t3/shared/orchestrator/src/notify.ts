// notify.ts — POST /v1/notify (G10)
//
// Receives {job_id, text}. Caller cannot choose a destination — destination is
// resolved from the job's input.reply_to (channel + thread_ts).
//
// Budget per job:
//   notify_count 0-1  → accept: write outbox slack_post, audit action "notify" status "ok"
//   notify_count 2    → reject: 429 with instructive error, audit status "pushback"
//   notify_count 3+   → accept AND deliver, audit status "flagged" (chronic over-notifiers visible in dashboard)
//
// This is the ONLY notify path. The opencode notify.ts tool calls this endpoint.

import type { FastifyInstance } from "fastify";
import db from "./db.js";
import { postSlackMessage } from "./actions/slack.js";
import { jobScopedToken } from "./opencode.js";

const PUSHBACK_MSG =
  "You have posted 2 updates already. Only notify again if something materially changed.";

interface JobRow {
  id: string;
  type: string;
  input: string;
  status: string;
  notify_count: number;
  session_id?: string;
}

export function registerNotifyRoute(app: FastifyInstance): void {
  app.post<{ Body: { job_id: string; text: string } }>(
    "/v1/notify",
    async (req, reply) => {
      const body = req.body as { job_id?: string; text?: string };

      if (!body.job_id || !body.text) {
        return reply.code(400).send({ error: "Missing required fields: job_id, text" });
      }

      const { job_id, text } = body;

      // Auth: accept the admin bearer OR this job's scoped token (HMAC(admin, jobId)).
      // The session subprocess only holds the scoped token, so a prompt-injected
      // leak authorizes notify for THIS job only, never the whole API.
      const header = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
      const adminToken = process.env.FLOW_ADMIN_TOKEN ?? "dev-token";
      const okAuth = header === adminToken || header === jobScopedToken(job_id);
      if (!okAuth) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job_id) as JobRow | undefined;
      if (!row) {
        return reply.code(404).send({ error: `Job not found: ${job_id}` });
      }

      let input: Record<string, unknown>;
      try {
        input = JSON.parse(row.input) as Record<string, unknown>;
      } catch {
        return reply.code(500).send({ error: "Job input is malformed" });
      }

      const reply_to = input.reply_to as { channel?: string; thread_ts?: string } | undefined;
      if (!reply_to?.channel) {
        return reply.code(409).send({ error: "No reply_to destination bound to this job" });
      }

      const event_id = (input.event_id as string | undefined) ?? null;
      const notify_count = row.notify_count ?? 0;

      // Always increment the counter (even on reject, so count 3 is always "after one rejection")
      db.prepare("UPDATE jobs SET notify_count = notify_count + 1, updated_at = unixepoch() WHERE id = ?").run(job_id);

      if (notify_count === 2) {
        // Reject with pushback — do NOT write outbox
        db.prepare(
          `INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail)
           VALUES (?, 'notify', 1.0, 'notify', ?, 'pushback', ?)`
        ).run(event_id, job_id, JSON.stringify({ text, notify_count }));

        return reply.code(429).send({ error: PUSHBACK_MSG });
      }

      const auditStatus: "ok" | "flagged" = notify_count >= 3 ? "flagged" : "ok";

      // Both ok and flagged DELIVER (user spec: an agent that insists after
      // pushback is trusted — it may genuinely need to alert). Flagged only
      // marks the audit so chronic over-notifiers are visible in the dashboard.
      await postSlackMessage({
        channel: reply_to.channel,
        thread_ts: reply_to.thread_ts,
        text,
        event_id: event_id ?? undefined,
      });

      db.prepare(
        `INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail)
         VALUES (?, 'notify', 1.0, 'notify', ?, ?, ?)`
      ).run(event_id, job_id, auditStatus, JSON.stringify({ text, notify_count }));

      if (auditStatus === "flagged") {
        return reply.send({
          ok: true,
          status: "flagged",
          message: "Notification accepted but flagged — you are sending many updates.",
        });
      }

      return reply.send({ ok: true, status: "sent" });
    }
  );
}

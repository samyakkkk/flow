// outbox-routes.ts — approve/dismiss for propose-mode rows.
// Approve replays the original event through executeAuto (policy forced to
// auto), so the concrete action logic lives in exactly one place. The proposal
// row is marked approved; the replay writes its own action/outbox/audit rows.

import type { FastifyInstance } from "fastify";
import db from "./db.js";
import { executeAuto } from "./actions/index.js";
import type { NormalizedEvent } from "./events.js";
import type { ClassificationResult } from "./classify.js";

const selectOutbox = db.prepare(`SELECT * FROM outbox WHERE id = ?`);
const updateOutboxStatus = db.prepare(`UPDATE outbox SET status = @status WHERE id = @id`);
const selectEvent = db.prepare(`SELECT * FROM events WHERE id = ?`);
const insertAudit = db.prepare(`
  INSERT INTO audit_log (event_id, classification, confidence, action, target, status)
  VALUES (@event_id, @classification, @confidence, @action, @target, @status)
`);

export function registerOutboxRoutes(app: FastifyInstance): void {
  app.patch<{ Params: { id: string }; Body: { decision: "approve" | "dismiss" } }>(
    "/v1/outbox/:id",
    async (req, reply) => {
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "dismiss") {
        return reply.code(400).send({ error: "decision must be 'approve' or 'dismiss'" });
      }

      const row = selectOutbox.get(req.params.id) as Record<string, unknown> | undefined;
      if (!row) return reply.code(404).send({ error: "Not found" });
      if (row.status !== "pending") {
        return reply.code(409).send({ error: `Row is '${row.status}', only pending rows can be decided` });
      }

      if (decision === "dismiss") {
        updateOutboxStatus.run({ id: row.id, status: "dismissed" });
        insertAudit.run({
          event_id: row.event_id ?? null, classification: "human_decision", confidence: 1.0,
          action: "outbox_dismiss", target: `outbox:${row.id}`, status: "ok",
        });
        return reply.send({ id: row.id, status: "dismissed" });
      }

      // approve: replay the original event in auto mode
      const eventRow = row.event_id ? (selectEvent.get(row.event_id) as Record<string, unknown> | undefined) : undefined;
      if (!eventRow?.classification_json) {
        return reply.code(409).send({ error: "Original event or its classification is missing; cannot replay" });
      }

      const event: NormalizedEvent = {
        id: eventRow.id as string,
        source: eventRow.source as NormalizedEvent["source"],
        type: eventRow.type as string,
        ts: eventRow.ts as number,
        payload: JSON.parse(eventRow.payload as string) as Record<string, unknown>,
        workspace: (eventRow.workspace as string) ?? undefined,
      };
      const classification = JSON.parse(eventRow.classification_json as string) as ClassificationResult;

      updateOutboxStatus.run({ id: row.id, status: "approved" });
      insertAudit.run({
        event_id: event.id, classification: "human_decision", confidence: 1.0,
        action: "outbox_approve", target: `outbox:${row.id}`, status: "ok",
      });
      await executeAuto({ event, classification, policy: "auto" });

      return reply.send({ id: row.id, status: "approved" });
    }
  );
}

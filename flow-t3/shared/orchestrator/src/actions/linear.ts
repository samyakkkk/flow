// linear.ts — Linear action: write comment or create/update ticket.
// Always writes to outbox; real adapter (to be built) drains it.

import db from "../db.js";

export interface LinearCommentOptions {
  ticket_id: string;
  body: string;
  event_id?: string;
}

export interface LinearTicketOptions {
  title: string;
  description?: string;
  team_id?: string;
  assignee_id?: string;
  event_id?: string;
}

export async function addLinearComment(opts: LinearCommentOptions): Promise<{ outbox_id: number }> {
  const result = db
    .prepare(
      `INSERT INTO outbox (event_id, action_type, payload)
       VALUES (@event_id, 'linear_comment', @payload)`
    )
    .run({
      event_id: opts.event_id ?? null,
      payload: JSON.stringify({ ticket_id: opts.ticket_id, body: opts.body }),
    });

  return { outbox_id: result.lastInsertRowid as number };
}

export async function createLinearTicket(opts: LinearTicketOptions): Promise<{ outbox_id: number }> {
  const result = db
    .prepare(
      `INSERT INTO outbox (event_id, action_type, payload)
       VALUES (@event_id, 'linear_ticket_create', @payload)`
    )
    .run({
      event_id: opts.event_id ?? null,
      payload: JSON.stringify({
        title: opts.title,
        description: opts.description,
        team_id: opts.team_id,
        assignee_id: opts.assignee_id,
      }),
    });

  return { outbox_id: result.lastInsertRowid as number };
}

export async function updateLinearTicketContext(
  ticket_id: string,
  context_body: string,
  event_id?: string
): Promise<{ outbox_id: number }> {
  const result = db
    .prepare(
      `INSERT INTO outbox (event_id, action_type, payload)
       VALUES (@event_id, 'linear_context_update', @payload)`
    )
    .run({
      event_id: event_id ?? null,
      payload: JSON.stringify({ ticket_id, context_body }),
    });

  return { outbox_id: result.lastInsertRowid as number };
}

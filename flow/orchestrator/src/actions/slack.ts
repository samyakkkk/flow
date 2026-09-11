// slack.ts — Slack action: post a message or DM.
// For external targets (non-test), writes to outbox; real adapter drains it.

import db from "../db.js";

export interface SlackPostOptions {
  channel: string;
  text: string;
  thread_ts?: string;
  event_id?: string;
}

export async function postSlackMessage(opts: SlackPostOptions): Promise<{ outbox_id: number }> {
  const result = db
    .prepare(
      `INSERT INTO outbox (event_id, action_type, payload)
       VALUES (@event_id, 'slack_post', @payload)`
    )
    .run({
      event_id: opts.event_id ?? null,
      payload: JSON.stringify({
        channel: opts.channel,
        text: opts.text,
        thread_ts: opts.thread_ts,
      }),
    });

  return { outbox_id: result.lastInsertRowid as number };
}

export async function dmController(text: string, event_id?: string): Promise<{ outbox_id: number }> {
  // DM the controller channel (FLOW_DM_CHANNEL env or a fallback label)
  const channel = process.env.FLOW_DM_CHANNEL ?? "flow-controller";
  return postSlackMessage({ channel, text, event_id });
}

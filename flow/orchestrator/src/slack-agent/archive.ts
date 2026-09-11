// Raw Slack archive + keyword-search mirror. No classification or memory
// extraction: capture is independent of whether the bot may answer a message.
import db from "../db.js";
import { containsSecret } from "../events.js";

type Obj = Record<string, any>;
export type SlackApi = (method: string, args: Obj) => Promise<Obj>;
const timestamp = () => String(Date.now() / 1000);
function revision(ts: string): string {
  const [whole, fraction = ""] = ts.split(".");
  return whole.padStart(16, "0") + fraction.padEnd(6, "0");
}
function nextCursor(result: Obj): string {
  const cursor = result.response_metadata?.next_cursor?.trim() ?? "";
  if (result.has_more && !cursor) throw new Error("incomplete_pagination: Slack returned more results without a cursor");
  return cursor;
}
export function saveSlackMessage(workspace: string, channel: string, event: Obj): void {
  const deleted = event.subtype === "message_deleted";
  const msg = event.message ?? event;
  const ts = deleted ? event.deleted_ts : msg.ts;
  if (!workspace || !channel || typeof ts !== "string") return;
  const id = `slack:${workspace}:${channel}:${ts}`;
  const ver = revision(String(deleted ? event.event_ts ?? timestamp() : msg.edited?.ts ?? msg.ts));
  const payload = JSON.stringify(event);
  // Preserve existing credential-screening policy, including file metadata.
  const hidden = deleted || containsSecret(payload);
  db.transaction(() => {
    const old = db.prepare("SELECT revision FROM slack_archive WHERE id = ?").get(id) as { revision: string } | undefined;
    if (old && old.revision > ver) return; // stale backfill cannot undo edits/deletes
    db.prepare(`INSERT INTO slack_archive (id, workspace, channel, ts, revision, deleted, payload, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
      deleted=excluded.deleted, payload=excluded.payload, captured_at=excluded.captured_at`)
      .run(id, workspace, channel, ts, ver, hidden ? 1 : 0, hidden ? null : payload, Date.now());
    if (hidden) {
      db.prepare("DELETE FROM slack_messages WHERE id = ?").run(id);
      // Legacy corpus projections must not retain deleted/secret text.
      db.prepare("DELETE FROM observations WHERE source = 'slack' AND source_id = ?").run(id);
      return;
    }
    if (typeof msg.text === "string") {
      db.prepare(`INSERT INTO slack_messages (id, workspace, channel, user_id, text, ts, thread_ts, permalink)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,
        user_id=excluded.user_id, thread_ts=excluded.thread_ts, permalink=excluded.permalink`)
        .run(id, workspace, channel, msg.user ?? msg.bot_id ?? null, msg.text, ts, msg.thread_ts ?? null,
          `slack://channel?team=${workspace}&id=${channel}&message=${ts}`);
    }
    if (msg.reply_count > 0 && msg.latest_reply) {
      db.prepare(`INSERT INTO slack_thread_sync (workspace,channel,ts,requested) VALUES (?,?,?,?)
        ON CONFLICT(workspace,channel,ts) DO UPDATE SET requested=MAX(requested,excluded.requested)`)
        .run(workspace, channel, ts, String(msg.latest_reply));
    }
  })();
}

export class SlackArchiveSync {
  private stopped = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listCursor = "";
  private discoveredAt = 0;
  private turn = 0;
  private retryAt = 0;
  private lastError: string | null = null;
  constructor(readonly workspace: string, private api: SlackApi) {
    // A reconnect may follow reinstalling the app with additional scopes.
    db.prepare("UPDATE slack_thread_sync SET error=NULL WHERE workspace=? AND error='missing_scope'").run(workspace);
  }

  start(): void { this.stopped = false; this.schedule(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.step().finally(() => this.schedule()); }, 2000);
    this.timer.unref?.();
  }
  async discover(): Promise<void> {
    const result = await this.api("conversations.list", { types: "public_channel,private_channel", limit: 200, cursor: this.listCursor || undefined });
    for (const c of result.channels ?? []) {
      db.prepare(`INSERT INTO slack_channels (workspace,id,name,is_private,is_ext_shared,is_member,is_archived)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET name=excluded.name,
        is_private=excluded.is_private,is_ext_shared=excluded.is_ext_shared,
        is_member=excluded.is_member,is_archived=excluded.is_archived`)
        .run(this.workspace, c.id, c.name ?? c.id, +!!c.is_private, +!!c.is_ext_shared, +!!c.is_member, +!!c.is_archived);
    }
    this.listCursor = result.response_metadata?.next_cursor ?? "";
    if (!this.listCursor) this.discoveredAt = Date.now();
  }
  async joinPublicChannels(): Promise<Obj> {
    // Explicit operation only. Private channels require member invitations.
    if (!this.discoveredAt || this.listCursor) throw new Error("Channel discovery is still running; retry after discovering=false");
    const rows = db.prepare("SELECT id FROM slack_channels WHERE workspace=? AND is_private=0 AND is_archived=0 AND is_member=0")
      .all(this.workspace) as Array<{ id: string }>;
    const joined: string[] = [], failed: Obj[] = [];
    for (const row of rows) {
      try {
        await this.api("conversations.join", { channel: row.id });
        db.prepare("UPDATE slack_channels SET is_member=1 WHERE workspace=? AND id=?").run(this.workspace, row.id);
        joined.push(row.id);
      } catch (err: any) {
        const error = err.data?.error ?? err.code ?? "join_failed";
        failed.push({ channel: row.id, error });
        if (error === "missing_scope" || err.retryAfter) break;
      }
    }
    return { joined, failed };
  }
  async step(): Promise<void> {
    if (this.busy || Date.now() < this.retryAt) return;
    this.busy = true;
    try {
      if (this.listCursor || Date.now() - this.discoveredAt > 300_000) { await this.discover(); return; }
      const thread = db.prepare(`SELECT t.* FROM slack_thread_sync t JOIN slack_channels c ON c.workspace=t.workspace AND c.id=t.channel
        WHERE t.workspace=? AND c.is_member=1 AND t.requested>t.completed AND t.error IS NULL LIMIT 1`)
        .get(this.workspace) as Obj | undefined;
      if (thread && this.turn++ % 2 === 0) {
        try {
          const res = await this.api("conversations.replies", { channel: thread.channel, ts: thread.ts, cursor: thread.cursor || undefined, limit: 100 });
          const cursor = nextCursor(res);
          db.transaction(() => {
            for (const msg of res.messages ?? []) saveSlackMessage(this.workspace, thread.channel, msg);
            db.prepare("UPDATE slack_thread_sync SET cursor=?, completed=? WHERE workspace=? AND channel=? AND ts=?")
              .run(cursor, cursor ? thread.completed : thread.requested, this.workspace, thread.channel, thread.ts);
          })();
        } catch (err: any) {
          if (err.data?.error === "invalid_cursor") {
            db.prepare("UPDATE slack_thread_sync SET cursor='' WHERE workspace=? AND channel=? AND ts=?")
              .run(this.workspace, thread.channel, thread.ts);
          }
          if (err.data?.error === "missing_scope" || err.data?.error === "thread_not_found") {
            db.prepare("UPDATE slack_thread_sync SET error=? WHERE workspace=? AND channel=? AND ts=?")
              .run(err.data.error, this.workspace, thread.channel, thread.ts);
          }
          throw err;
        }
        return;
      }
      const c = db.prepare(`SELECT * FROM slack_channels WHERE workspace=? AND is_member=1
        AND synced_at < ? ORDER BY synced_at, id LIMIT 1`).get(this.workspace, Date.now() - 300_000) as Obj | undefined;
      if (!c) return;
      const latest = c.latest || timestamp();
      db.prepare("UPDATE slack_channels SET latest=? WHERE workspace=? AND id=?").run(latest, this.workspace, c.id);
      try {
        const res = await this.api("conversations.history", { channel: c.id, oldest: c.oldest, latest,
          inclusive: true, cursor: c.cursor || undefined, limit: 100 });
        const cursor = nextCursor(res);
        db.transaction(() => {
          for (const msg of res.messages ?? []) saveSlackMessage(this.workspace, c.id, msg);
          db.prepare(`UPDATE slack_channels SET cursor=?, oldest=?, latest=?, synced_at=?, error=NULL WHERE workspace=? AND id=?`)
            .run(cursor, cursor ? c.oldest : latest, cursor ? latest : "", cursor ? 0 : Date.now(), this.workspace, c.id);
        })();
      } catch (err: any) {
        const error = err.data?.error ?? err.code ?? err.message ?? "sync_failed";
        db.prepare("UPDATE slack_channels SET error=?, synced_at=?, is_member=CASE WHEN ?='not_in_channel' THEN 0 ELSE is_member END WHERE workspace=? AND id=?")
          .run(error, Date.now(), error, this.workspace, c.id);
        if (error === "invalid_cursor") db.prepare("UPDATE slack_channels SET cursor='' WHERE workspace=? AND id=?").run(this.workspace, c.id);
        throw err;
      }
    } catch (err: any) {
      this.lastError = err.data?.error ?? err.code ?? err.message ?? "sync_failed";
      this.retryAt = Date.now() + Math.max(5000, Number(err.retryAfter ?? 5) * 1000);
    } finally { this.busy = false; }
  }
  status(): Obj {
    return {
      workspace: this.workspace,
      discovering: !!this.listCursor || !this.discoveredAt,
      last_error: this.lastError,
      retry_at: this.retryAt,
      thread_errors: db.prepare("SELECT channel,ts,error FROM slack_thread_sync WHERE workspace=? AND error IS NOT NULL").all(this.workspace),
      channels: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM slack_messages m WHERE m.workspace=c.workspace AND m.channel=c.id) AS messages
        FROM slack_channels c WHERE workspace=? ORDER BY name`).all(this.workspace),
      pending_threads: db.prepare("SELECT COUNT(*) AS count FROM slack_thread_sync WHERE workspace=? AND requested>completed").get(this.workspace),
    };
  }
}

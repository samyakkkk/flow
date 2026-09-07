import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
process.env.DB_PATH = ":memory:";
process.env.FLOW_DISTILLER = "0";
process.env.FLOW_POLL_DISABLE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
let db: typeof import("../src/db.js").default;
let archive: typeof import("../src/slack-agent/archive.js");
let search: typeof import("../src/memory/search.js");
let guard: typeof import("../src/slack-agent/access.js").internalUserGuard;
before(async () => {
  db = (await import("../src/db.js")).default;
  archive = await import("../src/slack-agent/archive.js");
  search = await import("../src/memory/search.js");
  guard = (await import("../src/slack-agent/access.js")).internalUserGuard;
  (await import("../src/memory/store.js")).setEmbedder(async () => null);
});
beforeEach(() => db.exec("DELETE FROM slack_messages; DELETE FROM slack_archive; DELETE FROM slack_channels; DELETE FROM slack_thread_sync;"));
const row = (id: string, member = true) => ({ id, name: id, is_member: member, is_private: false });

test("raw channel messages search across channels without producing memories", async () => {
  archive.saveSlackMessage("T1", "C1", { ts: "100.001", user: "U1", text: "Webhook incident: retry storms", files: [{ id: "F1", mimetype: "image/png" }] });
  archive.saveSlackMessage("T1", "C2", { ts: "100.002", user: "U2", text: "Webhook delivery requirements" });
  const result = await search.searchMemory({ query: "webhook" });
  assert.equal(result.corpus.length, 2);
  assert.ok(search.renderSearchResult(result).includes("slack://channel?team=T1"));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM memories").get() as any).n, 0);
  assert.match((db.prepare("SELECT payload FROM slack_archive WHERE channel='C1'").get() as any).payload, /image\/png/);
});

test("edits update FTS, duplicate delivery deduplicates, deletes survive stale backfill", async () => {
  const original = { ts: "100.001", user: "U1", text: "oldword" };
  archive.saveSlackMessage("T1", "C1", original);
  archive.saveSlackMessage("T1", "C1", original);
  archive.saveSlackMessage("T1", "C1", { subtype: "message_changed", message: { ...original, text: "newword", edited: { ts: "200.001" } } });
  archive.saveSlackMessage("T1", "C1", original);
  assert.equal((await search.searchMemory({ query: "oldword" })).corpus.length, 0);
  assert.equal((await search.searchMemory({ query: "newword" })).corpus.length, 1);
  archive.saveSlackMessage("T1", "C1", { subtype: "message_deleted", deleted_ts: original.ts, event_ts: "300.001" });
  archive.saveSlackMessage("T1", "C1", original);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM slack_messages").get() as any).n, 0);
  assert.equal((db.prepare("SELECT deleted FROM slack_archive").get() as any).deleted, 1);
});

test("credential-bearing payloads are not persisted", () => {
  archive.saveSlackMessage("T1", "C1", { ts: "100.001", text: "sk-abcdefghijklmnopqrstuvwxyz012345" });
  assert.equal((db.prepare("SELECT payload FROM slack_archive").get() as any).payload, null);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM slack_messages").get() as any).n, 0);
});

test("history resumes persisted pagination after sync restart and excludes unjoined channels", async () => {
  const calls: any[] = [];
  const api = async (method: string, args: any) => {
    calls.push({ method, ...args });
    if (method === "conversations.list") return { channels: [row("C1"), row("C2", false)] };
    return args.cursor ? { messages: [{ ts: "2.0", text: "second page" }] }
      : { messages: [{ ts: "3.0", text: "first page" }], response_metadata: { next_cursor: "page2" } };
  };
  const first = new archive.SlackArchiveSync("T1", api);
  await first.step(); await first.step();
  const second = new archive.SlackArchiveSync("T1", api);
  await second.step(); await second.step();
  const history = calls.filter((c) => c.method === "conversations.history");
  assert.equal(history[1].cursor, "page2");
  assert.equal(history[0].latest, history[1].latest);
  assert.ok(history.every((c) => c.channel === "C1"));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM slack_messages").get() as any).n, 2);
});

test("thread replies paginate and become searchable", async () => {
  const api = async (method: string, args: any) => {
    if (method === "conversations.list") return { channels: [row("C1")] };
    if (method === "conversations.history") return { messages: [{ ts: "1.0", text: "parent", reply_count: 2, latest_reply: "3.0" }] };
    return args.cursor ? { messages: [{ ts: "3.0", thread_ts: "1.0", text: "second reply" }] }
      : { messages: [{ ts: "2.0", thread_ts: "1.0", text: "first reply" }], response_metadata: { next_cursor: "next" } };
  };
  const sync = new archive.SlackArchiveSync("T1", api);
  for (let i = 0; i < 5; i++) await sync.step();
  assert.equal((await search.searchMemory({ query: "reply" })).corpus.length, 2);
  assert.equal((sync.status().pending_threads as any).count, 0);
});

test("join is explicit and missing scope is reported", async () => {
  let joins = 0;
  const sync = new archive.SlackArchiveSync("T1", async (method) => {
    if (method === "conversations.list") return { channels: [row("C1", false), row("C2", false)] };
    joins++; throw { data: { error: "missing_scope" } };
  });
  await sync.step();
  assert.equal(joins, 0);
  const result = await sync.joinPublicChannels();
  assert.equal(joins, 1);
  assert.equal(result.failed[0].error, "missing_scope");
});

test("external and unverifiable users cannot invoke Flow even if is_stranger is false", async () => {
  const allowed = guard("T1", async (_method, args) => {
    if (args.user === "bad") throw new Error("offline");
    return { user: { team_id: args.user === "internal" ? "T1" : "T2", is_stranger: false } };
  });
  assert.equal(await allowed("internal"), true);
  assert.equal(await allowed("external"), false);
  assert.equal(await allowed("bad"), false);
});

test("leaving a known channel removes its messages from search results", async () => {
  archive.saveSlackMessage("T1", "C1", { ts: "1.0", text: "incident" });
  const sync = new archive.SlackArchiveSync("T1", async () => ({ channels: [row("C1", false)] }));
  await sync.discover();
  assert.equal((await search.searchMemory({ query: "incident" })).corpus.length, 0);
});

test("Slack Connect answers are delivered privately without streaming to the shared channel", async () => {
  const { respond } = await import("../src/slack-agent/respond.js");
  const posts: any[] = [];
  await respond({
    client: { conversations: { replies: async () => ({ messages: [] }) }, chat: { postMessage: async (p) => { posts.push(p); } } },
    logger: { info() {}, warn() {}, error() {} },
    runtime: { name: "test", ask: async () => ({ markdown: "Internal answer", citations: [] }) },
    botUserId: "BOT", surface: "channel", channelId: "C1", threadTs: "1.0", messageTs: "1.0", userId: "U1", prompt: "help",
    resolveReplyChannel: async () => "D1",
    sayStream: () => { throw new Error("Must not stream to shared channel"); },
  });
  assert.equal(posts[0].channel, "D1");
  assert.equal(posts[0].thread_ts, undefined);
});

test("incomplete pagination never advances the history checkpoint", async () => {
  const sync = new archive.SlackArchiveSync("T1", async (method) => method === "conversations.list"
    ? { channels: [row("C1")] }
    : { messages: [{ ts: "1.0", text: "partial" }], has_more: true });
  await sync.step(); await sync.step();
  const channel = sync.status().channels[0];
  assert.equal(channel.oldest, "0");
  assert.match(channel.error, /incomplete_pagination/);
});

test("rate limiting defers further API requests without consuming history", async () => {
  let calls = 0;
  const sync = new archive.SlackArchiveSync("T1", async (method) => {
    calls++;
    if (method === "conversations.list") return { channels: [row("C1")] };
    throw { code: "slack_webapi_rate_limited_error", retryAfter: 60 };
  });
  await sync.step(); await sync.step(); await sync.step();
  assert.equal(calls, 2);
  assert.equal(sync.status().channels[0].oldest, "0");
  assert.ok(sync.status().retry_at > Date.now() + 50_000);
});

test("external ambient messages and mentions are captured without invoking the agent", async () => {
  const { registerListeners } = await import("../src/slack-agent/listeners.js");
  const handlers: Record<string, (args: any) => Promise<void>> = {};
  let captures = 0;
  let asks = 0;
  registerListeners({ event: (name: string, handler: any) => { handlers[name] = handler; } } as any, {
    botUserId: "BOT", capture: () => { captures++; }, authorize: async () => false,
    runtime: { name: "test", ask: async () => { asks++; return { markdown: "answer", citations: [] }; } },
  });
  const args = { event: { channel: "C1", user: "EXTERNAL", ts: "1.0", text: "<@BOT> hello" }, context: {},
    say: () => { throw new Error("Must not reply"); } };
  await handlers.message(args); await handlers.app_mention(args);
  assert.equal(captures, 2);
  assert.equal(asks, 0);
});

test("unresolved reply routing cannot call the model or fall back to a shared channel", async () => {
  const { respond } = await import("../src/slack-agent/respond.js");
  let actions = 0;
  await respond({
    client: { conversations: { replies: async () => ({ messages: [] }) }, chat: { postMessage: async () => { actions++; } } },
    logger: { info() {}, warn() {}, error() {} },
    runtime: { name: "test", ask: async () => { actions++; return { markdown: "answer", citations: [] }; } },
    botUserId: "BOT", surface: "channel", channelId: "C1", threadTs: "1.0", messageTs: "1.0", userId: "U1", prompt: "help",
    resolveReplyChannel: async () => { throw new Error("offline"); },
    say: async () => { actions++; },
  });
  assert.equal(actions, 0);
});

test("latest Slack reads use channel scope and timestamp order without needing keywords", async () => {
  const sync = new archive.SlackArchiveSync("T1", async () => ({channels:[{...row("C1"),name:"fluttergpt"},row("C2")]}));
  await sync.discover();
  archive.saveSlackMessage("T1","C1",{ts:"9.0",text:"older flutter conversation",user:"U1"});
  archive.saveSlackMessage("T1","C1",{ts:"100.0",thread_ts:"9.0",text:"latest reply",user:"U2"});
  archive.saveSlackMessage("T1","C2",{ts:"200.0",text:"different channel"});
  const found = await search.searchMemory({query:"type:thread channel:C1 sort:recent"});
  assert.deepEqual(found.corpus.map(r=>r.ts),["100.0","9.0"]);
  assert.match(search.renderSearchResult(found),/#fluttergpt.*at:1970-01-01T00:01:40.000Z.*user:U2/);
  assert.equal((await search.searchMemory({query:"channel:#fluttergpt sort:recent older"})).corpus.length,1);
  assert.equal((await search.searchMemory({query:"channel:<#C1> sort:recent",limit:1})).corpus[0].ts,"100.0");
  assert.equal((await search.searchMemory({query:"channel:missing sort:recent"})).corpus.length,0);
  db.prepare("UPDATE slack_channels SET is_member=0 WHERE id='C1'").run();
  assert.equal((await search.searchMemory({query:"channel:C1 sort:recent"})).corpus.length,0);
});

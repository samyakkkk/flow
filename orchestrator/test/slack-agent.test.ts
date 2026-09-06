// slack-agent.test.ts — unit tests for the Slack agent's non-Slack-API pieces.

import assert from "node:assert/strict";
import { test } from "node:test";
import { beginRun, cancelRun, endRun, inflightCount } from "../src/slack-agent/cancel.js";
import { isEngaged, markEngaged } from "../src/slack-agent/engagement.js";
import { stripMentions } from "../src/slack-agent/respond.js";
import { buildQuestion, renderAnswer, EchoRuntime } from "../src/slack-agent/runtime.js";
import { buildManifest, createAppUrl } from "../src/slack-agent/manifest.js";

test("stripMentions removes bot mentions and trims", () => {
  assert.equal(stripMentions("<@U12345ABC> what is flow?"), "what is flow?");
  assert.equal(stripMentions("hey <@U12345ABC> and <@U99999ZZZ>!"), "hey  and !");
  assert.equal(stripMentions("<@U12345ABC>"), "");
});

test("engagement store marks threads", () => {
  assert.equal(isEngaged("C1", "111.222"), false);
  markEngaged("C1", "111.222");
  assert.equal(isEngaged("C1", "111.222"), true);
  assert.equal(isEngaged("C1", "333.444"), false);
});

test("cancel registry aborts superseded and stopped runs", () => {
  const a = beginRun("C2", "1.0");
  const b = beginRun("C2", "1.0"); // supersedes a
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  assert.equal(cancelRun("C2", "1.0"), true);
  assert.equal(b.signal.aborted, true);
  assert.equal(cancelRun("C2", "1.0"), false);
  endRun("C2", "1.0", b);
  assert.equal(inflightCount(), 0);
});

test("buildQuestion folds thread transcript into the question", () => {
  const q = buildQuestion({
    prompt: "so what changed?",
    transcript: [
      { role: "user", text: "what is the drainer?" },
      { role: "assistant", text: "It polls the outbox." },
    ],
    context: { surface: "channel", channelId: "C1", threadTs: "1.0", userId: "U1" },
  });
  assert.match(q, /^Style: you're answering a colleague in Slack/);
  assert.match(q, /Conversation so far/);
  assert.match(q, /User: what is the drainer\?/);
  assert.match(q, /Flow: It polls the outbox\./);
  assert.match(q, /so what changed\?$/);
});

test("renderAnswer appends citations and gaps", () => {
  const md = renderAnswer({
    answer_md: "The drainer polls the outbox.",
    citations: [{ kind: "code", ref: "orchestrator/src/drainer.ts:1" }],
    gaps: ["retry policy unverified"],
  });
  assert.match(md, /^The drainer polls the outbox\./);
  assert.match(md, /\*Sources:\*\n• code: orchestrator\/src\/drainer\.ts:1/);
  assert.match(md, /\*Gaps:\* retry policy unverified/);
});

test("renderAnswer falls back on empty payloads", () => {
  assert.equal(renderAnswer({}), "(no answer)");
});

test("echo runtime reports surface and turn count", async () => {
  const echo = new EchoRuntime();
  const statuses: string[] = [];
  const answer = await echo.ask({
    prompt: "hello",
    transcript: [{ role: "user", text: "earlier" }],
    context: { surface: "dm", channelId: "D1", threadTs: "1.0", userId: "U1" },
    onStatus: (s) => statuses.push(s),
  });
  assert.match(answer.markdown, /You said: hello/);
  assert.match(answer.markdown, /1 prior turns/);
  assert.deepEqual(statuses, ["Echoing…"]);
});

test("manifest parameterizes app name and create URL embeds it", () => {
  const m = buildManifest("acme") as { display_information: { name: string }; settings: { socket_mode_enabled: boolean } };
  assert.equal(m.display_information.name, "Flow (acme)");
  assert.equal(m.settings.socket_mode_enabled, true);
  const plain = buildManifest("flow") as { display_information: { name: string } };
  assert.equal(plain.display_information.name, "Flow");
  const url = createAppUrl("acme");
  assert.match(url, /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  assert.match(decodeURIComponent(url), /Flow \(acme\)/);
});

test("queued coding tasks post once and update in order even without Slack status support", async () => {
  const { respond } = await import("../src/slack-agent/respond.js");
  const events: string[] = [];
  await respond({
    channelId: "QUEUE", threadTs: "1", messageTs: "1", userId: "U", botUserId: "B", surface: "channel", prompt: "edit",
    logger: { info() {}, warn() {}, error() {} },
    client: {
      conversations: { replies: async () => ({ messages: [] }) },
      chat: {
        postMessage: async ({ text, thread_ts }) => {
          assert.equal(thread_ts, "1");
          await new Promise(resolve => setTimeout(resolve, 10));
          events.push(`post:${text}`); return { ts: "notice" };
        },
        update: async ({ ts, text }) => { assert.equal(ts, "notice"); events.push(`update:${text}`); },
      },
    },
    runtime: { name: "test", async ask(q) {
      q.onCodingStatus?.("waiting"); q.onCodingStatus?.("waiting"); q.onCodingStatus?.("coding");
      return { markdown: "PR and validation" };
    } },
  });
  assert.equal(events.filter(e => e.includes("Yours is queued")).length, 1);
  const updates = events.filter(e => !e.includes("PR and validation"));
  assert.match(updates[0], /^post:Another coding task/);
  assert.equal(updates[1], "update:Your coding task has started.");
  assert.equal(updates[2], "update:Task finished. See the result in this thread.");
});

test("queue notice is cleared on cancellation and failure; ordinary questions post only an answer", async () => {
  const { respond } = await import("../src/slack-agent/respond.js");
  for (const mode of ["cancel", "fail", "question", "notice-fails"]) {
    const messages: string[] = [];
    await respond({
      channelId: `QUEUE-${mode}`, threadTs: "1", messageTs: "1", userId: "U", botUserId: "B", surface: "dm", prompt: "hello",
      logger: { info() {}, warn() {}, error() {} },
      client: { conversations: { replies: async () => ({}) }, chat: {
        postMessage: async ({ text }) => {
          if (mode === "notice-fails" && text.includes("queued")) throw new Error("Slack unavailable");
          messages.push(text); return { ts: "notice" };
        },
        update: async ({ text }) => { messages.push(text); },
      } },
      runtime: { name: "test", async ask(q) {
        if (mode !== "question") q.onCodingStatus?.("waiting");
        if (mode === "cancel") { cancelRun(`QUEUE-${mode}`, "1"); throw new DOMException("aborted", "AbortError"); }
        if (mode === "fail") throw new Error("failed test");
        return { markdown: "answer" };
      } },
    });
    if (mode === "question") assert.deepEqual(messages, ["answer"]);
    if (mode === "cancel") assert.match(messages.at(-1)!, /stopped.*no longer queued/);
    if (mode === "fail") assert.match(messages.at(-1)!, /Task failed/);
    if (mode === "notice-fails") assert.ok(messages.includes("answer"));
  }
});

test("cloud run links preserve the deployment path and reject invalid public URLs", async () => {
  const { cloudRunUrl } = await import("../src/slack-agent/runtime.js");
  assert.equal(cloudRunUrl("job-1", "https://flow.example/team/"), "https://flow.example/team/agents/cloud-job-1");
  assert.equal(cloudRunUrl("job-1", "https://flow.example"), "https://flow.example/agents/cloud-job-1");
  assert.equal(cloudRunUrl("job", "javascript:alert(1)"), undefined);
  assert.equal(cloudRunUrl("job", "https://secret@flow.example"), undefined);
});

test("coding task start and final answer include the online run link without needing a queue", async () => {
  const { respond } = await import("../src/slack-agent/respond.js");
  const messages: string[] = [];
  const url = "https://flow.example/team/agents/cloud-job";
  await respond({ channelId: "LINK", threadTs: "1", messageTs: "1", userId: "U", botUserId: "B", surface: "channel", prompt: "edit",
    logger: { info() {}, warn() {}, error() {} },
    client: { conversations: { replies: async () => ({}) }, chat: {
      postMessage: async ({ text }) => { messages.push(text); return { ts: "notice" }; },
      update: async ({ text }) => { messages.push(text); },
    } },
    runtime: { name: "test", async ask(q) { q.onCodingStatus?.("coding", url); return { markdown: "Verified changes" }; } },
  });
  assert.equal(messages.length, 3);
  for (const text of messages) assert.ok(text.includes(`<${url}|View agent run>`));
  assert.ok(messages.some(text => text.includes("Verified changes")));
});

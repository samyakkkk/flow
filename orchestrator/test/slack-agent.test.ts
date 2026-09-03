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

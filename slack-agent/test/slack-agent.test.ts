// slack-agent.test.ts — unit tests for the non-Slack-API pieces.

import assert from "node:assert/strict";
import { test } from "node:test";
import { beginRun, cancelRun, endRun, inflightCount } from "../src/cancel.js";
import { loadConfig } from "../src/config.js";
import { isEngaged, markEngaged } from "../src/engagement.js";
import { stripMentions } from "../src/respond.js";
import { EchoRuntime } from "../src/runtime/echo.js";

test("stripMentions removes bot mentions and trims", () => {
  assert.equal(stripMentions("<@U12345ABC> what is flow?"), "what is flow?");
  assert.equal(stripMentions("hey <@U12345ABC> and <@U99999ZZZ>!"), "hey  and !");
  assert.equal(stripMentions("<@U12345ABC>"), "");
});

test("engagement store marks and expires threads", () => {
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

test("config defaults", () => {
  const cfg = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.port, 80);
  assert.equal(cfg.runtime, "flow");
  assert.equal(cfg.orchestratorUrl, "http://localhost:7500");
  const echoCfg = loadConfig({ SLACK_AGENT_RUNTIME: "echo", SLACK_AGENT_PORT: "8080" } as unknown as NodeJS.ProcessEnv);
  assert.equal(echoCfg.runtime, "echo");
  assert.equal(echoCfg.port, 8080);
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

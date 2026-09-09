import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeTimersPromises from "node:timers/promises";

process.env.DB_PATH = ":memory:";
process.env.FLOW_DISTILLER = "1";
process.env.FLOW_SESSION_SEARCH = "0";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";

NodeTest.test(
  "loading a hosted runtime does not schedule legacy extraction, including on restart",
  async () => {
    const { default: db } = await import("../src/db.js");
    const llm = await import("../src/memory/llm.js");
    const trigger = await import("../src/memory/trigger.js");
    let calls = 0;
    llm.setLlmTransport(async () => {
      calls++;
      return "[]";
    });
    // A persisted T3 chat exists before the import-time recovery callback runs.
    db.prepare(`INSERT INTO agent_sessions(id,backend,repo,cwd,title,status,created_at,updated_at)
    VALUES ('t3-existing','ext:t3','flow','','','idle',1,1)`).run();
    trigger.setTranscriptReader(() => [
      { seq: 1, kind: "user_prompt", data: { text: "Keep the original regression assertion." } },
    ]);
    await NodeTimersPromises.setImmediate();
    NodeAssert.equal(calls, 0, "importing the runtime must not call the legacy model");
    NodeAssert.equal(await trigger.maybeDistill("t3-existing"), false);
    trigger.onSessionClosed("t3-existing");
    NodeAssert.equal(await trigger.idleSweep(), 0);
    await NodeTimersPromises.setImmediate();
    NodeAssert.equal(calls, 0, "T3 captures belong exclusively to the hosted curator");
    NodeAssert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM memory_distill_jobs").get() as { n: number }).n,
      0,
    );
    const { createCheckpoint } = await import("../src/memory/checkpoint.js");
    createCheckpoint("t3-existing", 0, {
      repo: "flow",
      branch: null,
      events: [{ seq: 1, kind: "user_prompt", data: { text: "Previously queued source." } }],
    });
    NodeAssert.equal(
      await trigger.maybeDistill("t3-existing"),
      false,
      "even a pre-existing legacy job must not resume",
    );
    NodeAssert.equal(calls, 0);
    trigger.stopIdleSweep();
  },
);

NodeTest.test("disabled memory extraction cannot invoke a consolidation model", async () => {
  const llm = await import("../src/memory/llm.js");
  let calls = 0;
  llm.setLlmTransport(async () => {
    calls++;
    return "same";
  });
  process.env.FLOW_DISTILLER = "0";
  try {
    await NodeAssert.rejects(
      llm.callLlm("Compare two memories", { tier: "fast", feature: "judge" }),
      /disabled/,
    );
    NodeAssert.equal(calls, 0);
  } finally {
    process.env.FLOW_DISTILLER = "1";
  }
});

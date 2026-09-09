import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import Database from "better-sqlite3";
import { CurationStore } from "../src/curation/store.js";
import { CurationPublicTools } from "../src/curation/public-tools.js";

NodeTest.test(
  "superseded procedures stay readable but leave normal discovery until restored",
  () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY, session TEXT, ts INTEGER); INSERT INTO t3_capture VALUES (1,'chat',1000),(2,'chat',2000),(3,'chat',3000)",
    );
    const store = new CurationStore(db);
    const cp = { sessionId: "chat", repo: "flow", after: 0, through: 1 };
    const skill = store.save(cp, {
      kind: "skill",
      name: "Standalone health check",
      description: "Check the former standalone runtime.",
      text: "Start the standalone process and read its health endpoint.",
      evidence: [1],
    });
    const tools = new CurationPublicTools(store);
    store.save(
      { ...cp, after: 1, through: 2 },
      {
        id: skill.id,
        kind: "skill",
        expectedRevision: skill.revision,
        status: "superseded",
        evidence: [2],
      },
    );
    NodeAssert.deepEqual(JSON.parse(tools.call("list_skills", {}, "chat")!.content[0]!.text), []);
    NodeAssert.deepEqual(
      JSON.parse(
        tools.call("list_skills", { query: "standalone health" }, "chat")!.content[0]!.text,
      ),
      [],
    );
    NodeAssert.doesNotMatch(
      JSON.stringify(tools.augment("orient", {}, { content: [] })),
      /Standalone health check/,
    );
    const retained = JSON.parse(
      tools.call("read_skill", { id: skill.id }, "chat")!.content[0]!.text,
    );
    NodeAssert.equal(retained.status, "superseded");
    NodeAssert.match(retained.text, /Start the standalone process/);
    NodeAssert.equal(store.list({ includeInactive: true }).length, 1);
    store.save(
      { ...cp, after: 2, through: 3 },
      {
        id: skill.id,
        kind: "skill",
        expectedRevision: retained.revision,
        status: "active",
        evidence: [3],
      },
    );
    NodeAssert.equal(
      JSON.parse(
        tools.call("list_skills", { query: "standalone health" }, "chat")!.content[0]!.text,
      )[0].id,
      skill.id,
    );
    db.close();
  },
);

NodeTest.test(
  "mixed entity batches preserve order, missing entries and conversation scope",
  async () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY, session TEXT, ts INTEGER); INSERT INTO t3_capture VALUES (1,'chat-a',1000)",
    );
    const store = new CurationStore(db);
    const cp = { sessionId: "chat-a", repo: "flow", after: 0, through: 1 };
    const skill = store.save(cp, {
      kind: "skill",
      name: "Test regression",
      description: "Reproduce and verify a regression.",
      text: "Run the same test before and after the fix.",
      evidence: [1],
    });
    const notes = store.bootstrap(cp, "Private original task");
    const tools = new CurationPublicTools(store);
    let calls = 0;
    const response = await tools.batch(
      { ids: [skill.id, "svc:test", notes.id, "missing", skill.id] },
      "chat-b",
      async (args) => {
        calls++;
        NodeAssert.deepEqual(args.ids, ["svc:test", "missing"]);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  { id: "svc:test", status: "found", node: { name: "Test" } },
                  { id: "missing", status: "not_found" },
                ],
              }),
            },
          ],
        };
      },
    );
    const payload = JSON.parse(response!.content[0]!.text);
    NodeAssert.equal(calls, 1);
    NodeAssert.deepEqual(
      payload.results.map((row: { id: string; status: string }) => [row.id, row.status]),
      [
        [skill.id, "found"],
        ["svc:test", "found"],
        [notes.id, "not_found"],
        ["missing", "not_found"],
        [skill.id, "found"],
      ],
    );
    NodeAssert.equal(payload.found, 3);
    NodeAssert.doesNotMatch(JSON.stringify(payload), /Private original task/);
    const readSkill = JSON.parse(
      tools.call("read_skill", { id: skill.id }, "chat-b")!.content[0]!.text,
    );
    NodeAssert.equal(readSkill.text, skill.text);
    NodeAssert.match(
      JSON.stringify(tools.augment("orient", {}, { content: [] })),
      /Test regression/,
    );
    db.close();
  },
);

NodeTest.test(
  "curated search honors anchored and corpus-only filters and excludes notes before ranking",
  () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY, session TEXT, ts INTEGER); INSERT INTO t3_capture VALUES (1,'chat',1000)",
    );
    const store = new CurationStore(db);
    const cp = { sessionId: "chat", repo: "flow", after: 0, through: 1 };
    const memory = store.save(cp, {
      kind: "memory",
      name: "Regression rule",
      text: "Retain regression failure evidence.",
      evidence: [1],
    });
    const skill = store.save(cp, {
      kind: "skill",
      name: "Regression test",
      description: "Verify regression fixes.",
      text: "Run the test.",
      evidence: [1],
    });
    const tools = new CurationPublicTools(store);
    const original = { content: [{ type: "text", text: "Existing search results" }] };
    for (const query of [
      "node:svc:test regression",
      "type:ticket regression",
      "type:thread regression",
      "channel:engineering regression",
      "sort:recent regression",
    ])
      NodeAssert.equal(tools.augment("search_knowledge", { query }, original), original);
    const response = JSON.stringify(
      tools.augment("search_knowledge", { query: "type:memory regression" }, original),
    );
    NodeAssert.match(response, new RegExp(memory.id));
    NodeAssert.doesNotMatch(response, new RegExp(skill.id));
    const envelope = {
      content: [
        { type: "text", text: JSON.stringify({ status: "ok", results: "Existing result" }) },
      ],
    };
    const augmented = tools.augment(
      "search_knowledge",
      { query: "regression" },
      envelope,
    ) as typeof envelope;
    NodeAssert.equal(augmented.content.length, 1);
    const decoded = JSON.parse(augmented.content[0]!.text);
    NodeAssert.equal(decoded.status, "ok");
    NodeAssert.match(decoded.results, /Existing result/);
    NodeAssert.match(decoded.results, new RegExp(memory.id));
    db.close();
  },
);

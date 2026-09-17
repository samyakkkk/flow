import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import Database from "better-sqlite3";
import { CurationStore } from "../src/curation/store.js";
import { CurationPublicTools } from "../src/curation/public-tools.js";
import { parseSearchTokens } from "../src/memory/search-query.js";

const search = (tools: CurationPublicTools, query: string) =>
  JSON.stringify(tools.augment("search_knowledge", { query }, { content: [] }));

NodeTest.test(
  "superseded procedures stay readable but leave discovery until restored",
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
    NodeAssert.doesNotMatch(search(tools, "type:skill standalone health"), new RegExp(skill.id));
    NodeAssert.doesNotMatch(
      JSON.stringify(tools.augment("orient", {}, { content: [] })),
      /Standalone health check/,
    );
    const retained = JSON.parse(tools.call("get_entity", { id: skill.id })!.content[0]!.text);
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
    NodeAssert.match(search(tools, "type:skill standalone health"), new RegExp(skill.id));
    db.close();
  },
);

NodeTest.test(
  "mixed entity batches preserve order and read another conversation's notes",
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
    const notes = store.bootstrap(cp, "Earlier original task");
    const tools = new CurationPublicTools(store);
    let calls = 0;
    const response = await tools.batch(
      { ids: [skill.id, "svc:test", notes.id, "missing", skill.id] },
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
        [notes.id, "found"],
        ["missing", "not_found"],
        [skill.id, "found"],
      ],
    );
    NodeAssert.equal(payload.found, 4);
    // A new conversation picks up where a previous one left off.
    NodeAssert.match(JSON.stringify(payload), /Earlier original task/);
    const otherChat = JSON.parse(tools.call("get_entity", { id: notes.id })!.content[0]!.text);
    NodeAssert.match(otherChat.text, /Earlier original task/);
    const readSkill = JSON.parse(tools.call("get_entity", { id: skill.id })!.content[0]!.text);
    NodeAssert.equal(readSkill.text, skill.text);
    const orient = JSON.stringify(tools.augment("orient", {}, { content: [] }, "t3-chat-b"));
    NodeAssert.match(orient, /Test regression/);
    NodeAssert.match(orient, /notes:t3-chat-b/);
    // Another conversation is listed by its opening request until extraction titles it.
    NodeAssert.match(orient, /RECENT CONVERSATIONS/);
    NodeAssert.match(orient, /Earlier original task/);
    NodeAssert.match(orient, new RegExp(notes.id));
    NodeAssert.match(orient, /TOOLS: search_knowledge[^\n]*get_entity \[id\] opens anything[^\n]*read_query/);
    // A conversation never lists itself as recent work to pick up.
    const own = JSON.stringify(tools.augment("orient", {}, { content: [] }, notes.sessionId));
    NodeAssert.doesNotMatch(own, /RECENT CONVERSATIONS/);
    db.close();
  },
);

NodeTest.test(
  "curated search honors anchored and corpus-only filters, kind tokens, and includes notes",
  () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY, session TEXT, ts INTEGER); INSERT INTO t3_capture VALUES (1,'chat',1000)",
    );
    const store = new CurationStore(db);
    const cp = { sessionId: "chat", repo: "flow", after: 0, through: 1 };
    const rule = store.save(cp, {
      kind: "doc",
      name: "Regression rule",
      description: "How regression evidence is retained.",
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
    const notes = store.bootstrap(cp, "Investigating a regression in onboarding");
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
    const docOnly = search(tools, "type:doc regression");
    NodeAssert.match(docOnly, new RegExp(rule.id));
    NodeAssert.doesNotMatch(docOnly, new RegExp(skill.id));
    NodeAssert.doesNotMatch(docOnly, new RegExp(notes.id));
    const skillOnly = search(tools, "type:skill regression");
    NodeAssert.match(skillOnly, new RegExp(skill.id));
    NodeAssert.doesNotMatch(skillOnly, new RegExp(rule.id));
    const notesOnly = search(tools, "type:notes regression");
    NodeAssert.match(notesOnly, new RegExp(notes.id));
    NodeAssert.doesNotMatch(notesOnly, new RegExp(skill.id));
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
    NodeAssert.match(decoded.results, new RegExp(rule.id));
    NodeAssert.match(decoded.results, new RegExp(notes.id));
    // A Brain document kind is a real filter: the token leaves the keywords, so the
    // Slack, Linear and memory search returns nothing for a kind it does not own.
    NodeAssert.deepEqual(
      [parseSearchTokens("type:notes regression").type, parseSearchTokens("type:notes regression").query],
      ["notes", "regression"],
    );
    // In a batch, each query's documents sit inside that query's section, and the
    // section's "nothing matched" line goes when documents did match.
    const none = "(nothing matched — try symptoms, identifiers, or file paths)";
    const batch = tools.augment(
      "search_knowledge",
      { queries: ["regression", "zzzunmatched"] },
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              results: `=== q1: regression ===\n${none}\n=== q2: zzzunmatched ===\n${none}`,
            }),
          },
        ],
      },
    ) as typeof envelope;
    const [first, second] = JSON.parse(batch.content[0]!.text).results.split("=== q2: ");
    NodeAssert.match(first, new RegExp(rule.id));
    NodeAssert.ok(!first.includes(none));
    NodeAssert.match(first, /get_entity \[id\] reads any of these/);
    NodeAssert.ok(second.includes(none));
    NodeAssert.doesNotMatch(second, new RegExp(rule.id));
    db.close();
  },
);

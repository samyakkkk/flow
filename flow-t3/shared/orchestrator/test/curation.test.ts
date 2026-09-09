import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import Database from "better-sqlite3";
import { CurationStore } from "../src/curation/store.js";
import { CuratorTools } from "../src/curation/tools.js";
import {
  normalizeTranscript,
  transcriptWindow,
  TranscriptBudget,
  TRANSCRIPT_HARD_CHARS,
  redactSecrets,
  excerpt,
} from "../src/curation/transcript.js";
import type { CaptureRow, CurationCheckpoint } from "../src/curation/types.js";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY, session TEXT, kind TEXT, data TEXT, ts INTEGER)",
  );
  let now = 1000;
  const store = new CurationStore(db, () => now);
  for (const [seq, session] of [
    [1, "chat-a"],
    [2, "chat-a"],
    [3, "chat-b"],
    [4, "chat-a"],
  ] as const)
    db.prepare("INSERT INTO t3_capture VALUES (?, ?, 'user_prompt', ?, ?)").run(
      seq,
      session,
      JSON.stringify({ text: "Use the Codex subscription through T3." }),
      seq * 1000,
    );
  const cp: CurationCheckpoint = { sessionId: "chat-a", repo: "flow", after: 0, through: 2 };
  return {
    db,
    store,
    cp,
    setNow: (value: number) => {
      now = value;
    },
  };
}

NodeTest.test(
  "capture ranges stay within their conversation and use a bounded sequence lookup",
  () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY, session TEXT NOT NULL,
    receipt TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL,
    UNIQUE(session, receipt))`);
    const insert = db.prepare("INSERT INTO t3_capture VALUES (?, ?, ?, 'user_prompt', ?, ?)");
    for (const [seq, session] of [
      [1, "chat-a"],
      [2, "chat-b"],
      [3, "chat-a"],
      [4, "chat-a"],
    ] as const)
      insert.run(seq, session, `receipt-${seq}`, JSON.stringify({ text: `Request ${seq}` }), seq);
    // Opening an existing capture store adds its range index without rewriting rows.
    const store = new CurationStore(db);
    NodeAssert.deepEqual(
      store.readCapture("chat-a", 1, 3).map((row) => row.seq),
      [3],
    );
    NodeAssert.deepEqual(
      store.readCapture("chat-b", 0, 4).map((row) => row.seq),
      [2],
    );
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT seq,kind,data,ts FROM t3_capture
    WHERE session=? AND seq>? AND seq<=? ORDER BY seq`)
      .all("chat-a", 1, 3) as Array<{ detail: string }>;
    NodeAssert.ok(
      plan.some((row) => /session=\? AND seq>\? AND seq<\?/.test(row.detail)),
      "Each incoming delta must not scan the entire conversation",
    );
    NodeAssert.ok(plan.every((row) => !row.detail.includes("TEMP B-TREE")));
    db.close();
  },
);

NodeTest.test("first-message notes, optimistic revisions and checkpoint provenance", () => {
  const f = fixture();
  const first = f.store.bootstrap({ ...f.cp, through: 1 }, "Please improve memory notes.");
  NodeAssert.match(first.text, /Please improve memory notes/);
  NodeAssert.equal(f.store.bootstrap({ ...f.cp, through: 1 }, "duplicate").revision, 1);
  const note = f.store.save(f.cp, {
    kind: "notes",
    expectedRevision: 1,
    text: "The user wants better memory notes.",
    evidence: [2],
  });
  NodeAssert.equal(note.revision, 2);
  NodeAssert.doesNotMatch(note.description, /before extraction/);
  NodeAssert.deepEqual(f.store.evidence(note.id), [
    { sessionId: "chat-a", seq: 1 },
    { sessionId: "chat-a", seq: 2 },
  ]);
  NodeAssert.throws(
    () => f.store.save(f.cp, { kind: "notes", expectedRevision: 1, text: "stale", evidence: [2] }),
    /revision 2/,
  );
  NodeAssert.throws(
    () => f.store.save(f.cp, { kind: "notes", expectedRevision: 2, text: "future", evidence: [4] }),
    /unavailable/,
  );
  NodeAssert.throws(
    () =>
      f.store.save(f.cp, { kind: "notes", id: "notes:chat-b", text: "wrong chat", evidence: [2] }),
    /Only this conversation/,
  );
  NodeAssert.throws(
    () =>
      f.store.save(f.cp, { kind: "memory", name: "foreign", text: "unsupported", evidence: [3] }),
    /unavailable/,
  );
  f.db.close();
});

NodeTest.test("a later chat refines an existing skill, with provenance in both chats", () => {
  const f = fixture();
  const skill = f.store.save(f.cp, {
    kind: "skill",
    name: "Test consultation cards",
    description: "Verify consultation UI on web and mobile.",
    text: "Run the focused tests and inspect the recorded result.",
    evidence: [2],
  });
  NodeAssert.match(skill.text, /^---\nname: "test-consultation-cards"\ndescription:/);
  const updated = f.store.save(
    { sessionId: "chat-b", repo: "flow", after: 0, through: 3 },
    {
      kind: "skill",
      id: skill.id,
      expectedRevision: 1,
      replaceFrom: "recorded result.",
      replaceTo: "recorded result, then verify an empty response separately.",
      evidence: [3],
    },
  );
  NodeAssert.equal(updated.revision, 2);
  NodeAssert.equal(f.store.list({ kind: "skill" }).length, 1);
  NodeAssert.equal(f.store.list({ sessionId: "chat-a" })[0]?.id, skill.id);
  NodeAssert.equal(f.store.list({ sessionId: "chat-b" })[0]?.id, skill.id);
  NodeAssert.equal(
    (
      new CuratorTools(f.store, f.cp, new TranscriptBudget()).execute("search_documents", {
        query: "consultation",
        kind: "skill",
      }) as unknown[]
    ).length,
    1,
  );
  f.db.close();
});

NodeTest.test(
  "temporal relevance fades, while standing decisions and resolved fixes remain readable",
  () => {
    const f = fixture();
    const standing = f.store.save(f.cp, {
      kind: "memory",
      name: "Codex subscription",
      text: "Use T3's adapter.",
      evidence: [1],
    });
    const temporal = f.store.save(f.cp, {
      kind: "memory",
      name: "Codex subscription limit",
      text: "Today's limit is reached.",
      lifecycle: "temporal",
      halfLifeDays: 1,
      evidence: [2],
    });
    f.setNow(1000 + 30 * 86_400_000);
    NodeAssert.equal(f.store.search("Codex subscription")[0]?.id, standing.id);
    NodeAssert.ok(f.store.get(temporal.id));
    const issue = f.store.save(f.cp, {
      kind: "memory",
      name: "Missing memory response",
      text: "MCP serialization needs a CallToolResult instance.",
      lifecycle: "issue",
      status: "resolved",
      evidence: [2],
    });
    NodeAssert.match(f.store.get(issue.id)!.text, /CallToolResult/);
    NodeAssert.equal(f.store.search("serialization")[0]?.id, issue.id);
    f.db.close();
  },
);

NodeTest.test(
  "archived temporal evidence keeps its original age through extraction and later historical edits",
  () => {
    const f = fixture();
    const today = 100 * 86_400_000;
    f.setNow(today);
    const old = f.store.save(f.cp, {
      kind: "memory",
      name: "Codex limit",
      text: "The subscription limit was reached.",
      lifecycle: "temporal",
      halfLifeDays: 1,
      evidence: [1],
    });
    NodeAssert.equal(old.observedAt, 1000);
    NodeAssert.equal(old.updatedAt, today);
    f.db.prepare("UPDATE t3_capture SET ts = ? WHERE seq = 2").run(today);
    const recent = f.store.save(f.cp, {
      kind: "memory",
      name: "Codex limit",
      text: "The current subscription limit was reached.",
      lifecycle: "temporal",
      halfLifeDays: 1,
      evidence: [2],
    });
    const revised = f.store.save(
      { ...f.cp, through: 4 },
      {
        kind: "memory",
        id: old.id,
        expectedRevision: 1,
        text: "The historical subscription limit was reached and later cleared.",
        evidence: [4],
      },
    );
    NodeAssert.equal(revised.observedAt, 4000);
    NodeAssert.equal(f.store.search("Codex limit")[0]?.id, recent.id);
    NodeAssert.ok(f.store.get(old.id));
    f.db.close();
  },
);

NodeTest.test(
  "existing documents backfill evidence dates once without changing revisions or edit dates",
  () => {
    const f = fixture();
    f.setNow(90 * 86_400_000);
    const doc = f.store.save(f.cp, {
      kind: "memory",
      name: "Archived deployment",
      text: "A historical deployment was verified.",
      evidence: [1, 2],
    });
    f.db.exec("ALTER TABLE brain_documents DROP COLUMN observed_at");
    const reopened = new CurationStore(f.db);
    NodeAssert.equal(reopened.get(doc.id)?.observedAt, 2000);
    NodeAssert.equal(reopened.get(doc.id)?.updatedAt, doc.updatedAt);
    NodeAssert.equal(reopened.get(doc.id)?.revision, 1);
    NodeAssert.equal(reopened.search("deployment")[0]?.id, doc.id);
    NodeAssert.equal(new CurationStore(f.db).get(doc.id)?.observedAt, 2000);
    f.db.close();
  },
);

NodeTest.test("failure retains the durable cursor and success advances it", () => {
  const f = fixture();
  f.store.setSession("chat-a", "extracting");
  f.store.setSession("chat-a", "error", undefined, "Provider limit reached");
  NodeAssert.equal(f.store.session("chat-a").lastSeq, 0);
  NodeAssert.ok(f.store.unfinishedSessions().includes("chat-a"));
  f.store.setSession("chat-a", "idle", 4);
  NodeAssert.equal(f.store.session("chat-a").error, null);
  NodeAssert.ok(!f.store.unfinishedSessions().includes("chat-a"));
  f.db.close();
});

NodeTest.test(
  "normalization coalesces deltas and keeps command outcomes and diff references bounded",
  () => {
    const rows: CaptureRow[] = [
      { seq: 1, kind: "user_prompt", data: { text: "Fix this test." }, ts: 1000 },
      {
        seq: 2,
        kind: "update",
        data: { sessionUpdate: "agent_message_chunk", content: { text: "I found " } },
        ts: 2000,
      },
      {
        seq: 3,
        kind: "update",
        data: { sessionUpdate: "agent_message_chunk", content: { text: "the cause." } },
        ts: 3000,
      },
      {
        seq: 4,
        kind: "update",
        data: {
          sessionUpdate: "tool_call_update",
          rawInput: {
            item: {
              type: "commandExecution",
              command: "vp test run a.test.ts",
              exitCode: 1,
              aggregatedOutput: "Failed assertion\n" + "log\n".repeat(10000),
            },
          },
        },
        ts: 4000,
      },
      {
        seq: 5,
        kind: "update",
        data: {
          sessionUpdate: "tool_call_update",
          rawInput: {
            item: { type: "fileChange", changes: [{ path: "a.ts", diff: "diff\n".repeat(10000) }] },
          },
        },
        ts: 5000,
      },
    ];
    const events = normalizeTranscript(rows);
    NodeAssert.equal(events.length, 4);
    NodeAssert.equal(events[1]?.text, "I found the cause.");
    NodeAssert.equal(events[1]?.seq, 3);
    NodeAssert.match(events[2]!.text, /Exit status: 1/);
    NodeAssert.match(events[2]!.text, /excerpt/);
    NodeAssert.ok(events[2]!.text.length < 2500);
    NodeAssert.match(events[3]!.text, /a.ts/);
    NodeAssert.match(events[3]!.text, /edit-evidence characters retained/);
    const window = transcriptWindow(events, 1000);
    NodeAssert.ok(window.characters <= 1000);
    NodeAssert.equal(window.omitted, true);
    NodeAssert.equal(window.through, 5);
  },
);

NodeTest.test(
  "tools cannot fetch future evidence, another chat's notes, or exceed the source budget",
  () => {
    const f = fixture();
    const budget = new TranscriptBudget();
    budget.reset(120000);
    budget.append(TRANSCRIPT_HARD_CHARS - 120000 - 200);
    const tools = new CuratorTools(f.store, f.cp, budget);
    NodeAssert.throws(() => tools.execute("read_evidence", { seq: 4 }), /unavailable/);
    NodeAssert.throws(() => tools.execute("read_evidence", { seq: 2 }), /budget exhausted/);
    NodeAssert.throws(() => budget.append(201), /bounded context/);
    const other = f.store.bootstrap(
      { sessionId: "chat-b", repo: "flow", after: 0, through: 3 },
      "A separate chat",
    );
    NodeAssert.throws(() => tools.execute("read_document", { id: other.id }), /scope/);
    f.db.close();
  },
);

NodeTest.test(
  "combined assistant references recover their original fragments within the checkpoint",
  () => {
    const f = fixture();
    const insert = f.db.prepare("INSERT INTO t3_capture VALUES (?, ?, 'update', ?, ?)");
    for (const [seq, session, text] of [
      [5, "chat-a", "I found "],
      [6, "chat-b", "Private unrelated text"],
      [7, "chat-a", "the cause."],
      [8, "chat-a", " Future result."],
    ] as const)
      insert.run(
        seq,
        session,
        JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { text } }),
        seq * 1000,
      );
    const tools = new CuratorTools(f.store, { ...f.cp, through: 7 }, new TranscriptBudget());
    const hits = tools.execute("search_transcript", { query: "the cause" }) as Array<{
      seq: number;
      fromSeq?: number;
    }>;
    NodeAssert.equal(hits[0]?.seq, 7);
    NodeAssert.equal(hits[0]?.fromSeq, 5);
    const passage = tools.execute("read_evidence", { ...hits[0], part: "output" }) as {
      text: string;
      totalCharacters: number;
    };
    NodeAssert.equal(passage.text, "I found the cause.");
    NodeAssert.equal(passage.totalCharacters, passage.text.length);
    NodeAssert.equal(
      (tools.execute("read_evidence", { seq: 5, part: "output" }) as { text: string }).text,
      "I found ",
    );
    NodeAssert.throws(
      () => tools.execute("read_evidence", { seq: 8, fromSeq: 5, part: "output" }),
      /unavailable/,
    );
    NodeAssert.throws(
      () => tools.execute("read_evidence", { seq: 7, fromSeq: 4, part: "output" }),
      /consecutive assistant/,
    );
    NodeAssert.throws(
      () => tools.execute("read_evidence", { seq: 7, fromSeq: 6, part: "output" }),
      /consecutive assistant/,
    );
    NodeAssert.deepEqual(f.store.readCapture("chat-a", 4, 5)[0]?.data, {
      sessionUpdate: "agent_message_chunk",
      content: { text: "I found " },
    });
    f.db.close();
  },
);

NodeTest.test(
  "credential redaction sees the combined assistant text, not only individual deltas",
  () => {
    const f = fixture();
    const rows: CaptureRow[] = ["Use sk-", "proj-abcdef12345"].map((text, index) => ({
      seq: index + 1,
      kind: "update",
      data: { sessionUpdate: "agent_message_chunk", content: { text } },
      ts: 1000 + index,
    }));
    const events = normalizeTranscript(rows);
    NodeAssert.equal(events[0]?.text, "Use [redacted credential]");
    NodeAssert.equal(events[0]?.fromSeq, 1);
    NodeAssert.equal(events[0]?.seq, 2);
    const separated = normalizeTranscript([
      rows[0]!,
      { seq: 3, kind: "graph", data: {}, ts: 2000 },
      { ...rows[1]!, seq: 4, ts: 3000 },
    ]);
    NodeAssert.equal(separated.length, 2);
    NodeAssert.equal(separated[1]?.fromSeq, undefined);
    for (const row of rows)
      f.db
        .prepare("UPDATE t3_capture SET kind=?,data=? WHERE seq=?")
        .run(row.kind, JSON.stringify(row.data), row.seq);
    const tools = new CuratorTools(f.store, f.cp, new TranscriptBudget());
    for (const part of ["all", "output"])
      NodeAssert.equal(
        (tools.execute("read_evidence", { seq: 2, fromSeq: 1, part }) as { text: string }).text,
        "Use [redacted credential]",
      );
    f.db.close();
  },
);

NodeTest.test(
  "evidence pagination fits its serialized result into the remaining context budget",
  () => {
    const f = fixture();
    const output = '\u0001\n\\"'.repeat(2000);
    f.db
      .prepare("UPDATE t3_capture SET kind='update',data=? WHERE seq=2")
      .run(JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { text: output } }));
    const budget = new TranscriptBudget();
    budget.reset(120000);
    budget.append(TRANSCRIPT_HARD_CHARS - budget.characters - 1000);
    const before = budget.characters;
    const tools = new CuratorTools(f.store, f.cp, budget);
    const page = tools.execute("read_evidence", { seq: 2, part: "output", limit: 8000 }) as {
      text: string;
      totalCharacters: number;
      nextOffset: number | null;
    };
    NodeAssert.ok(page.text.length > 0);
    NodeAssert.equal(page.text, output.slice(0, page.text.length));
    NodeAssert.equal(page.nextOffset, page.text.length);
    NodeAssert.equal(page.totalCharacters, output.length);
    NodeAssert.equal(budget.characters - before, JSON.stringify(page).length);
    NodeAssert.ok(budget.characters <= TRANSCRIPT_HARD_CHARS);
    f.db.close();
  },
);

NodeTest.test("credential-like values and pairing links are redacted", () => {
  NodeAssert.equal(
    redactSecrets("https://localhost/pair?token=privatevalue&view=chat"),
    "https://localhost/pair?token=[redacted]&view=chat",
  );
  NodeAssert.doesNotMatch(redactSecrets("key sk-proj-abcdef12345"), /abcdef12345/);
  NodeAssert.equal(
    redactSecrets("http://localhost/pair#token=privatevalue"),
    "http://localhost/pair#token=[redacted]",
  );
  const opaque = "aB1".repeat(20);
  NodeAssert.doesNotMatch(redactSecrets(`${opaque} hetzner api tokne`), new RegExp(opaque));
  const f = fixture();
  NodeAssert.doesNotMatch(
    f.store.bootstrap(f.cp, `Use API_KEY=${opaque}`).text,
    new RegExp(opaque),
  );
  NodeAssert.doesNotMatch(
    f.store.save(f.cp, {
      kind: "memory",
      name: "Sign in",
      text: `The password=${opaque} was supplied.`,
      evidence: [2],
    }).text,
    new RegExp(opaque),
  );
  f.db.close();
});

NodeTest.test(
  "Claude command results and exact edit replacements remain inspectable without inventing exit codes",
  () => {
    const command: CaptureRow = {
      seq: 1,
      kind: "update",
      ts: 1000,
      data: {
        sessionUpdate: "tool_call_update",
        status: "completed",
        rawInput: {
          toolName: "Bash",
          input: { command: "node --test test.js" },
          result: { type: "tool_result", content: "3 tests passed", is_error: false },
        },
      },
    };
    const edit: CaptureRow = {
      seq: 2,
      kind: "update",
      ts: 2000,
      data: {
        sessionUpdate: "tool_call_update",
        status: "completed",
        rawInput: {
          toolName: "Edit",
          input: {
            file_path: "src/app.ts",
            old_string: "return false;",
            new_string: "return true;",
          },
          result: { content: "File updated." },
        },
      },
    };
    const normalized = normalizeTranscript([command, edit]);
    NodeAssert.match(normalized[0]!.text, /node --test test.js/);
    NodeAssert.match(normalized[0]!.text, /3 tests passed/);
    NodeAssert.match(normalized[0]!.text, /Exit status: not recorded/);
    NodeAssert.match(normalized[1]!.text, /src\/app.ts/);
    const f = fixture();
    f.db.prepare("UPDATE t3_capture SET data=? WHERE seq=2").run(JSON.stringify(edit.data));
    const tools = new CuratorTools(f.store, f.cp, new TranscriptBudget());
    const evidence = tools.execute("read_evidence", { seq: 2, part: "diff" }) as { text: string };
    NodeAssert.match(evidence.text, /OLD:\nreturn false;\nNEW:\nreturn true;/);
    f.db.close();
  },
);

NodeTest.test(
  "existing legacy memories are read and refined in place with stale-edit protection",
  () => {
    const f = fixture();
    f.db.exec(
      "CREATE TABLE memories(id TEXT PRIMARY KEY, claim TEXT, kind TEXT, repo TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, embedding BLOB)",
    );
    f.db
      .prepare(
        "INSERT INTO memories VALUES ('existing', 'Run a focused regression check.', 'preference', 'flow', 'active', 1, 1, ?)",
      )
      .run(Buffer.from([1, 2]));
    const legacyStore = new CurationStore(f.db);
    const tools = new CuratorTools(legacyStore, f.cp, new TranscriptBudget());
    const hits = tools.execute("search_documents", {
      query: "regression",
      kind: "memory",
    }) as Array<{
      id: string;
      revision: number;
    }>;
    NodeAssert.deepEqual(
      hits.map((hit) => [hit.id, hit.revision]),
      [["mem:existing", 0]],
    );
    const edit = {
      id: "mem:existing",
      kind: "memory",
      expectedRevision: 0,
      text: "Run the same focused regression check before and after the fix.",
      evidence: [2],
    };
    NodeAssert.throws(() => tools.execute("write_document", edit), /Read this existing memory/);
    tools.execute("read_document", { id: "mem:existing" });
    f.db
      .prepare(
        "UPDATE memories SET claim='Run the focused check and retain the failure.' WHERE id='existing'",
      )
      .run();
    NodeAssert.throws(() => tools.execute("write_document", edit), /source may have changed/);
    tools.execute("read_document", { id: "mem:existing" });
    const saved = tools.execute("write_document", edit) as { id: string; revision: number };
    NodeAssert.equal(saved.revision, 1);
    NodeAssert.equal(f.store.search("regression", "memory").length, 1);
    NodeAssert.deepEqual(
      f.db.prepare("SELECT claim,embedding FROM memories WHERE id='existing'").get(),
      {
        claim: edit.text,
        embedding: null,
      },
    );
    NodeAssert.deepEqual(f.store.evidence(saved.id), [{ sessionId: "chat-a", seq: 2 }]);
    f.db.prepare("DELETE FROM memories WHERE id='existing'").run();
    NodeAssert.equal(f.store.get(saved.id), undefined);
    NodeAssert.equal(f.store.search("regression", "memory").length, 0);
    NodeAssert.deepEqual(f.store.evidence(saved.id), []);
    f.db.close();
  },
);

NodeTest.test(
  "foreign conversation notes cannot crowd relevant reusable documents out of search",
  () => {
    const f = fixture();
    for (let i = 0; i < 400; i++)
      f.db
        .prepare(`INSERT INTO brain_documents(id,kind,name,description,text,revision,session_id,repo,lifecycle,status,created_at,updated_at)
    VALUES (?, 'notes', 'regression testing', '', 'regression testing', 1, ?, 'flow', 'standing', 'active', 1, 1)`)
        .run(`notes:foreign-${i}`, `foreign-${i}`);
    const memory = f.store.save(f.cp, {
      kind: "memory",
      name: "Focused checks",
      text: "Use regression testing.",
      evidence: [2],
    });
    const tools = new CuratorTools(f.store, f.cp, new TranscriptBudget());
    NodeAssert.deepEqual(
      (
        tools.execute("search_documents", { query: "regression testing" }) as Array<{ id: string }>
      ).map((d) => d.id),
      [memory.id],
    );
    f.db.close();
  },
);

NodeTest.test(
  "registered source reads are bounded reference context, redacted and unavailable without an owner",
  async () => {
    const f = fixture();
    const budget = new TranscriptBudget();
    budget.reset(120000);
    const tools = new CuratorTools(f.store, f.cp, budget, async (name, args) => {
      NodeAssert.equal(name, "source_read");
      NodeAssert.deepEqual(args, {
        repo: "flow",
        path: ".agents/skills/test/SKILL.md",
        start_line: 1,
        end_line: 100,
      });
      return {
        repo: "flow",
        revision: "a".repeat(40),
        content: "Use API_KEY=sk-proj-hidden12345\n" + "Step\n".repeat(10000),
      };
    });
    const result = (await tools.executeAsync("source_read", {
      repo: "flow",
      path: ".agents/skills/test/SKILL.md",
    })) as { source: string; excerpt: string; omitted: boolean };
    NodeAssert.match(result.source, /reference context/);
    NodeAssert.equal(result.omitted, true);
    NodeAssert.doesNotMatch(result.excerpt, /hidden12345/);
    NodeAssert.match(result.excerpt, /redacted/);
    NodeAssert.ok(budget.characters > 120000 && budget.characters <= 150000);
    await NodeAssert.rejects(
      new CuratorTools(f.store, f.cp, new TranscriptBudget()).executeAsync("source_search", {
        repo: "flow",
        query: "test",
      }),
      /unavailable/,
    );
    budget.append(budget.remaining - 400);
    await NodeAssert.rejects(
      tools.executeAsync("source_read", { repo: "flow", path: "file" }),
      /budget exhausted/,
    );
    f.db.close();
  },
);

NodeTest.test(
  "tiny excerpts stay bounded even when the normal omission marker does not fit",
  () => {
    for (const cap of [0, 1, 10, 40, 80])
      NodeAssert.ok(excerpt("sensitive output ".repeat(100), cap).length <= cap);
    NodeAssert.match(excerpt("long output ".repeat(100), 40), /omitted/);
  },
);

NodeTest.test(
  "indexed retrieval rebuilds old documents and follows edits, deletion and meaningful query terms",
  () => {
    const f = fixture();
    const first = f.store.save(f.cp, {
      kind: "memory",
      name: "Trim normalization",
      text: "Preserve the failing regression assertion.",
      evidence: [1],
    });
    f.store.save(f.cp, {
      kind: "memory",
      name: "Deployment",
      text: "We completed the deployment and checked the service.",
      evidence: [2],
    });
    f.db.exec(
      "DROP TRIGGER brain_documents_ai; DROP TRIGGER brain_documents_ad; DROP TRIGGER brain_documents_au; DROP TABLE brain_documents_fts",
    );
    const rebuilt = new CurationStore(f.db);
    NodeAssert.deepEqual(
      rebuilt.search("How do we test trim normalization?").map((doc) => doc.id),
      [first.id],
    );
    NodeAssert.deepEqual(rebuilt.search("how do we"), []);
    rebuilt.save(f.cp, {
      kind: "memory",
      id: first.id,
      expectedRevision: 1,
      name: "Whitespace validation",
      text: "Keep the correct expected value.",
      evidence: [2],
    });
    NodeAssert.deepEqual(rebuilt.search("trim normalization"), []);
    NodeAssert.equal(rebuilt.search("whitespace validation")[0]?.id, first.id);
    const unicode = rebuilt.save(f.cp, {
      kind: "memory",
      name: "名前 正規化",
      text: "空白処理を確認する。",
      evidence: [2],
    });
    NodeAssert.equal(rebuilt.search("正規化")[0]?.id, unicode.id);
    f.db.prepare("DELETE FROM brain_documents WHERE id=?").run(first.id);
    NodeAssert.deepEqual(rebuilt.search("whitespace validation"), []);
    f.db.close();
  },
);

NodeTest.test(
  "quoted credential fields and Slack tokens are redacted without damaging JSON envelopes",
  () => {
    const opaque = "opaque123".repeat(4);
    const data = {
      api_key: opaque,
      url: "https://localhost/pair#token=privatevalue",
      slackToken: ["xoxb", "123456789012", "123456789012", "secret123456789"].join("-"),
    };
    const redacted = redactSecrets(JSON.stringify(data));
    NodeAssert.doesNotMatch(redacted, new RegExp(opaque));
    NodeAssert.doesNotMatch(redacted, /secret123456789|privatevalue/);
    const parsed = JSON.parse(redacted);
    NodeAssert.match(parsed.api_key, /redacted/);
    NodeAssert.equal(parsed.url, "https://localhost/pair#token=[redacted]");
  },
);

NodeTest.test(
  "metadata corrections do not require a prose rewrite and identical skill bodies do not churn revisions",
  () => {
    const f = fixture();
    const memory = f.store.save(f.cp, {
      kind: "memory",
      name: "Regression rule",
      text: "Keep the failing assertion unchanged.",
      lifecycle: "temporal",
      halfLifeDays: 7,
      evidence: [1],
    });
    const corrected = f.store.save(f.cp, {
      id: memory.id,
      kind: "memory",
      expectedRevision: 1,
      lifecycle: "standing",
      description: "A lasting regression verification rule.",
      evidence: [2],
    });
    NodeAssert.equal(corrected.lifecycle, "standing");
    NodeAssert.equal(corrected.halfLifeDays, null);
    NodeAssert.equal(corrected.revision, 2);
    const skill = f.store.save(f.cp, {
      kind: "skill",
      name: "Focused regression",
      description: "Verify a focused regression.",
      text: "Run the same focused command before and after the fix.",
      evidence: [1],
    });
    NodeAssert.throws(
      () =>
        f.store.save(f.cp, {
          id: skill.id,
          kind: "skill",
          expectedRevision: 1,
          text: "Run the same focused command before and after the fix.",
          evidence: [2],
        }),
      /No meaningful change/,
    );
    NodeAssert.equal(f.store.get(skill.id)?.revision, 1);
    f.db.close();
  },
);

NodeTest.test(
  "binary tool captures stay out of text evidence while command text and secret redaction survive",
  () => {
    const f = fixture();
    const encoded = "abcd/EFGH+ijkl".repeat(16_000);
    const payload = {
      sessionUpdate: "tool_call_update",
      title: "Read screenshot",
      status: "completed",
      rawInput: {
        toolName: "Read",
        input: { file_path: "screenshot.png" },
        result: {
          content: [
            {
              type: "text",
              text: "The screenshot was captured; visual content has not been checked.",
            },
            { type: "image", source: { type: "base64", media_type: "image/png", data: encoded } },
          ],
        },
      },
    };
    f.db
      .prepare("UPDATE t3_capture SET kind='update',data=? WHERE seq=2")
      .run(JSON.stringify(payload));
    const event = normalizeTranscript(f.store.readCapture("chat-a", 1, 2))[0]!;
    NodeAssert.match(event.text, /screenshot was captured/);
    NodeAssert.match(event.text, /Binary content omitted/);
    NodeAssert.doesNotMatch(event.text, /abcd\/EFGH/);
    const tools = new CuratorTools(f.store, f.cp, new TranscriptBudget());
    const evidence = tools.execute("read_evidence", { seq: 2, part: "all" }) as {
      text: string;
      totalCharacters: number;
    };
    NodeAssert.match(evidence.text, /image\/png/);
    NodeAssert.match(evidence.text, /Binary content omitted/);
    NodeAssert.ok(evidence.totalCharacters < 1000);
    NodeAssert.equal(redactSecrets(encoded), encoded);
    NodeAssert.equal(
      redactSecrets("A".repeat(60) + " is my api key"),
      "[redacted credential] is my api key",
    );
    // Retained source remains untouched; this projection adds no binary archive.
    NodeAssert.equal(
      JSON.parse(
        (f.db.prepare("SELECT data FROM t3_capture WHERE seq=2").get() as { data: string }).data,
      ).rawInput.result.content[1].source.data,
      encoded,
    );
    f.db.close();
  },
);

NodeTest.test(
  "retained branch context accompanies the original conversation without implying the current checkout",
  () => {
    const [event] = normalizeTranscript([
      {
        seq: 1,
        kind: "created",
        ts: 1000,
        data: { repo: "flow", branch: "historical-deployment", backend: "ext:t3" },
      },
    ]);
    NodeAssert.match(event!.text, /branch: historical-deployment/);
    NodeAssert.match(event!.text, /source conversation at this event/);
    NodeAssert.equal(event!.seq, 1);
  },
);

NodeTest.test("skill frontmatter retains string names and valid slugs at export boundaries", () => {
  const f = fixture();
  for (const title of ["2026", "Yes", "a".repeat(63) + " boundary", "名前"]) {
    const skill = f.store.save(f.cp, {
      kind: "skill",
      name: title,
      description: "Run the demonstrated focused check.",
      text: "Run the focused check and inspect its result.",
      evidence: [1],
    });
    const serializedName = skill.text.match(/^name: (.+)$/m)?.[1];
    NodeAssert.ok(serializedName);
    // JSON strings are valid YAML scalars and cannot become numbers or booleans.
    const name: unknown = JSON.parse(serializedName);
    NodeAssert.equal(typeof name, "string");
    NodeAssert.match(name as string, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    NodeAssert.ok((name as string).length <= 64);
  }
  f.db.close();
});

NodeTest.test("turn summaries retain recorded failure and interruption explanations", () => {
  const rows: CaptureRow[] = [
    {
      seq: 1,
      ts: 1000,
      kind: "update",
      data: {
        sessionUpdate: "turn_completed",
        state: "failed",
        errorMessage: "Subscription limit reached.",
        stopReason: "provider_error",
      },
    },
    {
      seq: 2,
      ts: 2000,
      kind: "update",
      data: {
        sessionUpdate: "turn_completed",
        state: "interrupted",
        reason: "User stopped verification before it finished.",
      },
    },
  ];
  const text = normalizeTranscript(rows)
    .map((event) => event.text)
    .join("\n");
  NodeAssert.match(text, /Subscription limit reached/);
  NodeAssert.match(text, /provider_error/);
  NodeAssert.match(text, /User stopped verification before it finished/);
});

NodeTest.test(
  "document titles, descriptions and skill frontmatter redact captured credentials",
  () => {
    const f = fixture();
    try {
      const credential = "sk-proj-fixturecredential0123456789";
      const doc = f.store.save(f.cp, {
        kind: "skill",
        name: `Test with ${credential}`,
        description: "Use the test flow at http://localhost:8115/pair#token=fixture-token-12345",
        text: "Use isolated state and inspect the recorded check result.",
        evidence: [2],
      });
      NodeAssert.ok(!JSON.stringify(doc).includes(credential));
      NodeAssert.ok(!JSON.stringify(doc).includes("fixture-token-12345"));
      NodeAssert.match(doc.text, /redacted/);
      NodeAssert.equal(f.store.get(doc.id)?.description, doc.description);
    } finally {
      f.db.close();
    }
  },
);

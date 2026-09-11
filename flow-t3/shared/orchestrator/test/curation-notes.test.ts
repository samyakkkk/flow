import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import Database from "better-sqlite3";
import { noteChunks, linkedNoteChunks } from "../src/curation/notes.js";
import { CurationStore } from "../src/curation/store.js";
import { CuratorTools } from "../src/curation/tools.js";
import { TranscriptBudget } from "../src/curation/transcript.js";

const notes = (revision: number, color: string) => `# Button design
## Continue this work
Implement the accepted button design.
## User instructions and preferences
### P1@${revision} — Button color
User preference, scoped to the checkout button: ${color}.
Sources: E${revision}
## Work log
### L1 — Initial design
Applied P1@1 to the first draft. Sources: E1
`;

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY, session TEXT, kind TEXT, data TEXT, ts INTEGER)");
  for (const seq of [1, 2]) db.prepare("INSERT INTO t3_capture VALUES (?, 'chat', 'user_prompt', '{}', ?)").run(seq, seq);
  return { db, store: new CurationStore(db), cp: { sessionId: "chat", repo: "flow", after: 0, through: 2 } };
}

NodeTest.test("topic chunks retain evidence and expand instruction/log links bidirectionally", () => {
  const chunks = noteChunks(notes(1, "blue"));
  NodeAssert.deepEqual(chunks.map((chunk) => chunk.id), ["continuation", "P1", "L1"]);
  NodeAssert.deepEqual(linkedNoteChunks(chunks, "P1").map((chunk) => chunk.id), ["P1", "L1"]);
  NodeAssert.deepEqual(linkedNoteChunks(chunks, "L1").map((chunk) => chunk.id), ["L1", "P1"]);
  NodeAssert.deepEqual(chunks[1]!.evidence, [1]);
});

NodeTest.test("corrections replace active chunks but retain original note revisions", () => {
  const { db, store, cp } = fixture();
  try {
    const before = store.save(cp, { kind: "notes", text: notes(1, "blue"), evidence: [1] });
    const after = store.save(cp, { kind: "notes", expectedRevision: before.revision, text: notes(2, "green"), evidence: [2] });
    NodeAssert.match(store.chunks(after.id).find((chunk) => chunk.id === "P1")!.text, /green/);
    NodeAssert.match(store.revision(after.id, before.revision)!.text, /blue/);
    // An old log must not be expanded with a newly corrected preference.
    NodeAssert.deepEqual(linkedNoteChunks(store.chunks(after.id), "L1").map((chunk) => chunk.id), ["L1"]);
    NodeAssert.throws(() => store.save(cp, { kind: "notes", expectedRevision: after.revision, text: notes(2, "red"), evidence: [2] }), /increment its revision/);
    NodeAssert.equal(store.get(after.id)!.revision, after.revision);
  } finally { db.close(); }
});

NodeTest.test("reject dangling instruction links and unavailable inline evidence atomically", () => {
  const { db, store, cp } = fixture();
  try {
    NodeAssert.throws(() => store.save(cp, { kind: "notes", text: notes(1, "blue").replace("Applied P1@1", "Applied P9@1"), evidence: [1] }), /Unknown instruction/);
    NodeAssert.throws(() => store.save(cp, { kind: "notes", text: notes(1, "blue").replace("Sources: E1", "Sources: E999"), evidence: [1] }), /unavailable/);
    NodeAssert.equal(store.get("notes:chat"), undefined);
  } finally { db.close(); }
});

NodeTest.test("docs share versioned storage with skills and memories cannot be written", () => {
  const { db, store, cp } = fixture();
  try {
    const doc = store.save(cp, { kind: "doc", folder: "Company/Mission", name: "Mission", text: "Help customers retain context.", evidence: [1] });
    NodeAssert.equal(store.get(doc.id)!.folder, "Company/Mission");
    NodeAssert.equal(store.revision(doc.id, 1)!.text, doc.text);
    NodeAssert.throws(() => store.save(cp, { kind: "memory", name: "Old format", text: "A result", evidence: [1] }), /disabled/);
    NodeAssert.throws(() => store.save(cp, { kind: "doc", folder: "../Company", name: "Mission", text: "Context", evidence: [1] }), /topic folder/);
    const tools = new CuratorTools(store, cp, new TranscriptBudget());
    NodeAssert.throws(() => tools.execute("write_document", { kind: "memory", evidence: [1], text: "No" }), /Invalid document kind/);
    NodeAssert.throws(() => tools.execute("read_document_revision", { id: "notes:another-chat", revision: 1 }), /not found/);
  } finally { db.close(); }
});

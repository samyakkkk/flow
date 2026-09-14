import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { CurationStore } from "../src/curation/store.js";
import { exportBrain, importBrain } from "../src/curation/transfer.js";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(`CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,receipt TEXT,kind TEXT,data TEXT,ts INTEGER,UNIQUE(session,receipt));
    CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,backend TEXT,repo TEXT,cwd TEXT,title TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);`);
  const store = new CurationStore(db, () => 1000);
  return { db, store };
}
function seed(f: ReturnType<typeof fixture>, session = "t3-chat") {
  const seq = Number(
    f.db
      .prepare(
        "INSERT INTO t3_capture(session,receipt,kind,data,ts) VALUES (?,'prompt','user_prompt','{}',100)",
      )
      .run(session).lastInsertRowid,
  );
  const cp = { sessionId: session, repo: "org/repo", after: 0, through: seq };
  const notes = f.store.bootstrap(cp, "Keep migration resumable.");
  const doc = f.store.save(cp, {
    kind: "doc",
    name: "Migration",
    text: `Decision from E${seq}.`,
    evidence: [seq],
  });
  const skill = f.store.save(cp, {
    kind: "skill",
    name: "Migrate",
    description: "Use when moving a local Brain to Cloud.",
    text: `Read source E${seq}.`,
    evidence: [seq],
  });
  return { seq, notes, doc, skill };
}
test("merges documents, skills, notes, revisions and evidence into a populated Brain", () => {
  const source = fixture(),
    target = fixture();
  const existing = seed(target, "t3-team");
  const original = seed(source);
  const snapshot = exportBrain(source.db);
  const receipt = importBrain(target.db, snapshot, "computer-a", "brain-a");
  assert.equal(receipt.documents, 3);
  assert.equal(target.store.get(existing.doc.id)?.text, existing.doc.text);
  const notes = target.store.get("notes:t3-computer-a:chat")!;
  assert.equal(notes.text, original.notes.text);
  const id = `import:computer-a:brain-a:${original.doc.id}`;
  const doc = target.store.get(id)!;
  assert.equal(doc.sessionId, "t3-computer-a:chat");
  const evidence = target.store.evidence(id);
  assert.equal(evidence[0]?.seq, 2);
  assert.match(doc.text, /E2/);
  assert.equal(target.store.revision(id, 1)?.id, id);
  assert.equal(target.store.revision(id, 1)?.text, doc.text);
  assert.ok(
    target.db
      .prepare(
        "SELECT rowid FROM brain_documents_fts WHERE brain_documents_fts MATCH 'name:Migration' AND rowid=(SELECT rowid FROM brain_documents WHERE id=?)",
      )
      .get(id),
  );
  assert.deepEqual(target.db.pragma("foreign_key_check"), []);
  source.db.close();
  target.db.close();
});
test("retry receipt preserves subsequent team edits and a second user's content", () => {
  const a = fixture(),
    b = fixture(),
    target = fixture();
  const doc = seed(a).doc;
  seed(b);
  const snapshot = exportBrain(a.db);
  const receipt = importBrain(target.db, snapshot, "a", "brain");
  const id = `import:a:brain:${doc.id}`;
  target.db.prepare("UPDATE brain_documents SET text='Team edited this' WHERE id=?").run(id);
  assert.deepEqual(importBrain(target.db, snapshot, "a", "brain"), receipt);
  assert.equal(target.store.get(id)?.text, "Team edited this");
  importBrain(target.db, exportBrain(b.db), "b", "brain");
  assert.equal(target.store.list({ includeInactive: true }).length, 6);
  assert.ok(target.store.get("notes:t3-b:chat"));
  const changed = structuredClone(snapshot);
  changed.tables.brain_documents[0]!.text = "changed";
  assert.throws(() => importBrain(target.db, changed, "a", "brain"), /different snapshot/);
  a.db.close();
  b.db.close();
  target.db.close();
});
test("invalid evidence rolls back all rows and can be retried with a valid snapshot", () => {
  const source = fixture(),
    target = fixture();
  seed(source);
  const snapshot = exportBrain(source.db),
    bad = structuredClone(snapshot);
  bad.tables.brain_document_evidence[0]!.seq = 999;
  assert.throws(() => importBrain(target.db, bad, "a", "brain"), /Missing transferred evidence/);
  assert.equal(target.store.list().length, 0);
  assert.equal(
    (target.db.prepare("SELECT count(*) AS n FROM t3_capture").get() as { n: number }).n,
    0,
  );
  assert.equal(importBrain(target.db, snapshot, "a", "brain").documents, 3);
  assert.throws(() => importBrain(target.db, { version: 2 }, "b", "brain"), /Unsupported/);
  source.db.close();
  target.db.close();
});

test("retains chronological revisions and rebuilds note citations for future curation", () => {
  const source = fixture(),
    target = fixture();
  seed(target, "t3-other");
  const { seq, notes } = seed(source);
  const next = Number(
    source.db
      .prepare(
        "INSERT INTO t3_capture(session,receipt,kind,data,ts) VALUES ('t3-chat','followup','user_prompt','{}',200)",
      )
      .run().lastInsertRowid,
  );
  source.store.save(
    { sessionId: "t3-chat", repo: "org/repo", after: seq, through: next },
    {
      kind: "notes",
      expectedRevision: notes.revision,
      text: `## Continue this work\nPreserve the migration. E${next}\n\n## Preferences\n### P1@1 — Retry safely\nDo not duplicate uploads. E${next}`,
      evidence: [next],
    },
  );
  source.db
    .prepare("INSERT INTO brain_curation_sessions VALUES ('t3-chat',?,'extracting',NULL,200)")
    .run(next);
  importBrain(target.db, exportBrain(source.db), "a", "brain");
  const id = "notes:t3-a:chat";
  assert.equal(target.store.get(id)?.revision, 2);
  assert.equal(target.store.revision(id, 1)?.text, notes.text);
  assert.match(target.store.get(id)!.text, /E3/);
  assert.equal(target.store.session("t3-a:chat").lastSeq, 3);
  assert.equal(target.store.session("t3-a:chat").status, "idle");
  const payload = target.db
    .prepare("SELECT payload FROM brain_note_chunks WHERE document_id=? AND entry_id='P1'")
    .get(id) as { payload: string };
  assert.deepEqual(JSON.parse(payload.payload).evidence, [3]);
  source.db.close();
  target.db.close();
});

test("post-migration sync updates imported documents and keeps evidence identities stable", () => {
  const source = fixture(), target = fixture();
  seed(target, "t3-team");
  const original = seed(source);
  importBrain(target.db, exportBrain(source.db), "a", "brain");
  target.store.applySync("a", source.store.pendingSync());
  assert.equal(target.store.list().length, 6);
  const next = Number(source.db.prepare("INSERT INTO t3_capture(session,receipt,kind,data,ts) VALUES ('t3-chat','next','user_prompt','{}',200)").run().lastInsertRowid);
  source.store.save({ sessionId: "t3-chat", repo: "org/repo", after: 0, through: next }, {
    kind: "doc", id: original.doc.id, expectedRevision: original.doc.revision,
    name: "Migration", text: `Continue E${original.seq} with E${next}.`, evidence: [original.seq, next],
  });
  const pending = source.store.pendingSync();
  target.store.applySync("a", pending);
  target.store.applySync("a", pending);
  const id = `import:a:brain:${original.doc.id}`;
  assert.equal(target.store.list().length, 6);
  assert.equal(target.store.get(id)?.revision, 2);
  assert.equal(target.store.get(id)?.text, "Continue E2 with E3.");
  assert.deepEqual(target.store.evidence(id).map(e => e.seq), [2,3]);
  assert.equal(target.store.revision(id, 1)?.text, "Decision from E2.");
  assert.equal((target.db.prepare("SELECT kind FROM t3_capture WHERE seq=3").get() as {kind:string}).kind, "evidence_reference");
  source.db.close(); target.db.close();
});

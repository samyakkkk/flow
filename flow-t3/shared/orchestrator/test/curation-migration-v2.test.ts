import { test } from "node:test";
import * as assert from "node:assert/strict";
import Database from "better-sqlite3";
import { CURATION_SCHEMA, CurationStore } from "../src/curation/store.js";
import { memoryFingerprint, publishCuration } from "../src/curation/migration.js";

function oldDatabase() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY, session TEXT, kind TEXT, data TEXT, ts INTEGER)");
  db.exec(CURATION_SCHEMA.replace("'notes','doc'", "'notes'"));
  db.exec(`CREATE TABLE memories(id TEXT PRIMARY KEY, claim TEXT);
    INSERT INTO memories VALUES ('legacy','Retain me');
    INSERT INTO t3_capture VALUES (1,'chat','user_prompt','{}',1);
    INSERT INTO brain_documents(rowid,id,kind,name,text,session_id,created_at,updated_at)
      VALUES (2,'memory','memory','Remember','Retain this too','chat',1,1),
             (3,'notes:chat','notes','Old notes','Original prose','chat',1,1);
    INSERT INTO brain_document_evidence VALUES ('memory','chat',1),('notes:chat','chat',1);
    CREATE VIRTUAL TABLE brain_documents_fts USING fts5(name,description,text,content='brain_documents',content_rowid='rowid',tokenize='porter unicode61');
    INSERT INTO brain_documents_fts(brain_documents_fts) VALUES ('rebuild');`);
  return db;
}
const checkpoint = { sessionId: "chat", repo: "flow", after: 0, through: 1 };
function revise(db: Database.Database) {
  return new CurationStore(db).save(checkpoint, {
    kind: "notes", expectedRevision: 1, evidence: [1],
    text: "# Design\n## Continue this work\nChoose the scoped design.\n## User instructions and preferences\n### P1@1 — Color\nUser wants green for checkout. Sources: E1",
  });
}

test("legacy schema upgrades preserve memories, evidence, rowids and FTS on repeated initialization", () => {
  const db = oldDatabase();
  try {
    const before = memoryFingerprint(db);
    const rowids = db.prepare("SELECT rowid,id FROM brain_documents ORDER BY rowid").all();
    new CurationStore(db); new CurationStore(db);
    assert.equal(memoryFingerprint(db), before);
    assert.deepEqual(db.prepare("SELECT rowid,id FROM brain_documents ORDER BY rowid").all(), rowids);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.exec("INSERT INTO brain_documents_fts(brain_documents_fts,rank) VALUES('integrity-check',1)");
  } finally { db.close(); }
});

test("publication preserves memories and original notes, is repeatable, and leaves capture/cursors alone", () => {
  const live = oldDatabase(); new CurationStore(live);
  const baseline = new Database(live.serialize());
  const staged = new Database(live.serialize());
  try {
    const before = memoryFingerprint(live);
    revise(staged);
    assert.deepEqual(publishCuration(live, baseline, staged), ["notes:chat"]);
    assert.deepEqual(publishCuration(live, baseline, staged), []);
    assert.equal(memoryFingerprint(live), before);
    const store = new CurationStore(live);
    assert.equal(store.revision("notes:chat", 1)?.text, "Original prose");
    assert.match(store.get("notes:chat")!.text, /green/);
    assert.equal(store.chunks("notes:chat").length, 2);
    assert.equal(store.session("chat").lastSeq, 0);
    assert.deepEqual(live.prepare("SELECT COUNT(*) AS n FROM t3_capture").get(), { n: 1 });
  } finally { live.close(); baseline.close(); staged.close(); }
});

test("concurrent document or source changes reject the entire publication", () => {
  for (const sourceConflict of [false, true]) {
    const live = oldDatabase(); new CurationStore(live);
    const baseline = new Database(live.serialize());
    const staged = new Database(live.serialize());
    try {
      revise(staged);
      new CurationStore(staged).save(checkpoint, {kind:"doc",name:"Mission",text:"Customer context",evidence:[1]});
      if (sourceConflict) live.exec("UPDATE t3_capture SET data='changed' WHERE seq=1");
      else live.exec("UPDATE brain_documents SET text='A newer live note' WHERE kind='notes'");
      assert.throws(() => publishCuration(live, baseline, staged), /changed/);
      assert.deepEqual(live.prepare("SELECT COUNT(*) AS n FROM brain_documents WHERE kind='doc'").get(), { n: 0 });
      assert.equal(new CurationStore(live).get("notes:chat")!.revision, 1);
    } finally { live.close(); baseline.close(); staged.close(); }
  }
});

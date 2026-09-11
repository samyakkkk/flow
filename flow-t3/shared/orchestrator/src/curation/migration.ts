import * as Crypto from "node:crypto";
import type Database from "better-sqlite3";
import { CurationStore } from "./store.js";

type Row = Record<string, unknown>;
const rows = (db: Database.Database, sql: string) => db.prepare(sql).all() as Row[];
export function memoryFingerprint(db: Database.Database): string {
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE name='memories'").get()
    ? rows(db, "SELECT * FROM memories ORDER BY id") : [];
  return Crypto.createHash("sha256").update(JSON.stringify([
    legacy, rows(db, "SELECT * FROM brain_documents WHERE kind='memory' ORDER BY id").map(({folder: _folder, ...row}) => row),
    rows(db, "SELECT e.* FROM brain_document_evidence e JOIN brain_documents d ON d.id=e.document_id WHERE d.kind='memory' ORDER BY e.document_id,e.session_id,e.seq"),
  ])).digest("hex");
}

export function documentFingerprint(db: Database.Database, id: string): string {
  const row = db.prepare("SELECT * FROM brain_documents WHERE id=?").get(id) as Row | undefined;
  const { folder = "", ...rest } = row ?? {};
  return JSON.stringify([row ? { ...rest, folder } : null,
    db.prepare("SELECT * FROM brain_document_evidence WHERE document_id=? ORDER BY session_id,seq").all(id)]);
}

/** Apply only generated document changes, never replace a live database or its capture.
 * The caller must snapshot first and initialize the schema separately. All conflicts
 * are checked under the same write lock as publication; a stale stage cannot win.
 */
export function publishCuration(live: Database.Database, baseline: Database.Database, staged: Database.Database): string[] {
  const baselineStore = new CurationStore(baseline);
  const stagedStore = new CurationStore(staged);
  const changed = stagedStore.list({ includeInactive: true }).filter(d =>
    d.kind !== "memory" && documentFingerprint(staged, d.id) !== documentFingerprint(baseline, d.id));
  return live.transaction(() => {
    const preserved = memoryFingerprint(live);
    const pending = changed.filter(d => documentFingerprint(live, d.id) !== documentFingerprint(staged, d.id));
    for (const doc of pending) {
      if (documentFingerprint(live, doc.id) !== documentFingerprint(baseline, doc.id))
        throw new Error(`Live document changed during generation: ${doc.id}. Refresh and replay; nothing published.`);
      for (const source of stagedStore.evidence(doc.id)) {
        const query = "SELECT kind,data,ts FROM t3_capture WHERE session=? AND seq=?";
        if (JSON.stringify(live.prepare(query).get(source.sessionId, source.seq)) !==
            JSON.stringify(staged.prepare(query).get(source.sessionId, source.seq)))
          throw new Error(`Source changed or is missing: ${source.sessionId}/E${source.seq}`);
      }
    }
    for (const doc of pending) {
      const source = staged.prepare("SELECT * FROM brain_documents WHERE id=?").get(doc.id) as Row;
      const columns = Object.keys(source);
      // Fixed schema column names, never model-controlled SQL identifiers.
      const quoted = columns.map(k => `"${k.replaceAll('"', '""')}"`);
      live.prepare(`INSERT INTO brain_documents (${quoted.join(",")}) VALUES (${columns.map(() => "?").join(",")})
        ON CONFLICT(id) DO UPDATE SET ${quoted.filter(k => k !== '"id"').map(k => `${k}=excluded.${k}`).join(",")}`)
        .run(...columns.map(k => source[k]));
      for (const table of ["brain_document_evidence", "brain_document_revisions", "brain_note_chunks"]) {
        live.prepare(`DELETE FROM ${table} WHERE document_id=?`).run(doc.id);
        for (const record of staged.prepare(`SELECT * FROM ${table} WHERE document_id=?`).all(doc.id) as Row[]) {
          const keys = Object.keys(record);
          live.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => record[k]));
        }
      }
      // Preserve a pre-upgrade snapshot even when the baseline predates revision storage.
      const old = baselineStore.get(doc.id);
      if (old) live.prepare("INSERT OR IGNORE INTO brain_document_revisions VALUES (?,?,?)")
        .run(doc.id, old.revision, JSON.stringify(old));
    }
    if (memoryFingerprint(live) !== preserved) throw new Error("Memory preservation check failed.");
    if ((live.pragma("foreign_key_check") as unknown[]).length) throw new Error("Foreign key validation failed.");
    return pending.map(d => d.id);
  }).immediate();
}

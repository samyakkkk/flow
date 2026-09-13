import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { redactSecrets } from "./transcript.js";

// Only portable knowledge is exported; provider credentials and runtime configuration
// never belong in a Brain transfer. Destination triggers rebuild FTS; note chunks
// and revisions retain their content with remapped evidence references.
const tables = {
  t3_capture: "seq session receipt kind data ts",
  brain_documents:
    "id kind folder name description text revision session_id repo lifecycle status half_life_days created_at updated_at observed_at",
  brain_document_evidence: "document_id session_id seq",
  brain_document_revisions: "document_id revision snapshot",
  brain_note_chunks: "document_id entry_id document_revision payload",
  brain_curation_sessions: "session_id last_seq status error updated_at",
} as const;
type Table = keyof typeof tables;
type Row = Record<string, string | number | null>;
export type BrainTransfer = { version: 1; tables: Record<Table, Row[]> };
export function exportBrain(db: Database.Database): BrainTransfer {
  return db.transaction(() => ({
    version: 1 as const,
    tables: Object.fromEntries(
      Object.entries(tables).map(([table, columns]) => [
        table,
        (db.prepare(`SELECT ${columns.split(" ").join(",")} FROM ${table}`).all() as Row[]).map(
          (row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                typeof value === "string" &&
                ["text", "description", "name", "data", "snapshot", "payload", "error"].includes(
                  key,
                )
                  ? redactSecrets(value)
                  : value,
              ]),
            ),
        ),
      ]),
    ) as BrainTransfer["tables"],
  }))();
}
function decode(value: unknown): BrainTransfer {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("tables" in value)
  )
    throw new Error("Unsupported Brain transfer version.");
  const input = value.tables;
  if (!input || typeof input !== "object") throw new Error("Invalid transfer tables.");
  for (const [table, columns] of Object.entries(tables)) {
    const rows = (input as Record<string, unknown>)[table];
    if (!Array.isArray(rows)) throw new Error(`Missing transfer table ${table}.`);
    for (const row of rows) {
      if (
        !row ||
        typeof row !== "object" ||
        Object.keys(row).sort().join() !== columns.split(" ").sort().join()
      )
        throw new Error(`Invalid transfer row in ${table}.`);
      for (const cell of Object.values(row))
        if (
          cell !== null &&
          typeof cell !== "string" &&
          !(typeof cell === "number" && Number.isFinite(cell))
        )
          throw new Error("Invalid transfer cell.");
    }
  }
  return value as BrainTransfer;
}
/** A receipt and every imported row commit together. Retrying cannot replace team edits. */
export function importBrain(
  db: Database.Database,
  input: unknown,
  instance: string,
  source: string,
) {
  const snapshot = decode(input);
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(instance) || !/^[a-zA-Z0-9-]{1,100}$/.test(source))
    throw new Error("Invalid transfer origin.");
  const origin = `${instance}:${source}`;
  const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  db.exec(
    "CREATE TABLE IF NOT EXISTS brain_imports(origin TEXT PRIMARY KEY, digest TEXT NOT NULL, documents INTEGER NOT NULL)",
  );
  return db.transaction(() => {
    const prior = db
      .prepare("SELECT digest, documents FROM brain_imports WHERE origin = ?")
      .get(origin) as { digest: string; documents: number } | undefined;
    if (prior) {
      if (prior.digest !== digest)
        throw new Error("This Brain was already imported from a different snapshot.");
      return prior;
    }
    const session = (id: string) => (id ? `t3-${instance}:${id.replace(/^t3-/, "")}` : "");
    const ids = new Map(
      snapshot.tables.brain_documents.map((row) => [
        String(row.id),
        row.kind === "notes"
          ? `notes:${session(String(row.session_id))}`
          : `import:${origin}:${row.id}`,
      ]),
    );
    db.prepare("INSERT OR IGNORE INTO brain_import_evidence VALUES (?,'',0,0)").run(instance);
    const sequences = new Map<number, number>();
    for (const row of snapshot.tables.t3_capture) {
      const sid = session(String(row.session));
      db.prepare(`INSERT OR IGNORE INTO agent_sessions(id,backend,repo,cwd,title,status,created_at,updated_at)
        VALUES (?,'ext:t3',NULL,'','','idle',?,?)`).run(sid, row.ts, row.ts);
      db.prepare(
        "INSERT OR IGNORE INTO t3_capture(session,receipt,kind,data,ts) VALUES (?,?,?,?,?)",
      ).run(sid, row.receipt, row.kind, row.data, row.ts);
      const target = db
        .prepare("SELECT seq FROM t3_capture WHERE session=? AND receipt=?")
        .get(sid, row.receipt) as { seq: number };
      sequences.set(Number(row.seq), target.seq);
      db.prepare("INSERT INTO brain_import_evidence VALUES (?,?,?,?)").run(instance, row.session, row.seq, target.seq);
    }
    const seq = (n: number) => {
      if (n === 0) return 0;
      const mapped = sequences.get(n);
      if (mapped === undefined) throw new Error(`Missing transferred evidence E${n}.`);
      return mapped;
    };
    const text = (s: string): string => {
      const exact = ids.get(s);
      if (exact) return exact;
      return s.replace(/\bE([1-9]\d*)\b/g, (original, n: string) =>
        sequences.has(Number(n)) ? `E${seq(Number(n))}` : original,
      );
    };
    const json = (value: unknown, key = ""): unknown => {
      if (Array.isArray(value)) return value.map((v) => json(v, key));
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v, k)]));
      if (typeof value === "number" && ["seq", "evidence"].includes(key)) return seq(value);
      if (typeof value === "string") return key === "sessionId" ? session(value) : text(value);
      return value;
    };
    for (const table of Object.keys(tables) as Table[]) {
      if (table === "t3_capture") continue;
      const columns = tables[table].split(" ");
      const insert = db.prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      for (const original of snapshot.tables[table]) {
        const row = { ...original };
        for (const [key, value] of Object.entries(row)) {
          if (key === "document_id" || (table === "brain_documents" && key === "id")) {
            const id = ids.get(String(value));
            if (!id) throw new Error("Missing transferred document.");
            row[key] = id;
          } else if (key === "session_id") row[key] = session(String(value));
          else if (key === "seq" || key === "last_seq") row[key] = seq(Number(value));
          else if ((key === "snapshot" || key === "payload") && typeof value === "string")
            row[key] = JSON.stringify(json(JSON.parse(value)));
          else if (typeof value === "string") row[key] = text(value);
        }
        if (table === "brain_curation_sessions") {
          row.status = "idle";
          row.error = null;
        }
        insert.run(...columns.map((c) => row[c]!));
      }
    }
    for (const row of snapshot.tables.brain_documents)
      db.prepare("INSERT INTO brain_document_sync_origins VALUES (?,?,?,?)").run(instance, row.id, row.revision, ids.get(String(row.id)));
    const documents = snapshot.tables.brain_documents.length;
    db.prepare("INSERT INTO brain_imports VALUES (?,?,?)").run(origin, digest, documents);
    return { digest, documents };
  })();
}

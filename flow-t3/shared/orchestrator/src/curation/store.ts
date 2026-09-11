import * as NodeCrypto from "node:crypto";
import type Database from "better-sqlite3";
import { meaningfulTokens } from "../memory/search-query.js";
import { redactSecrets } from "./transcript.js";
import { noteChunks, type NoteChunk } from "./notes.js";
import type {
  BrainDocument,
  BrainDocumentSummary,
  CaptureRow,
  CurationCheckpoint,
  CurationSession,
  DocumentKind,
  SaveDocument,
} from "./types.js";

const COLUMNS = `id, kind, folder, name, description, revision, session_id AS sessionId, repo,
  lifecycle, status, half_life_days AS halfLifeDays, created_at AS createdAt, updated_at AS updatedAt,
  observed_at AS observedAt`;
export const CURATION_SCHEMA = `
  CREATE INDEX IF NOT EXISTS t3_capture_session_sequence ON t3_capture(session, seq);
  CREATE TABLE IF NOT EXISTS brain_documents (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('notes','doc','memory','skill')),
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, session_id TEXT NOT NULL, repo TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'standing', status TEXT NOT NULL DEFAULT 'active',
    half_life_days REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS brain_documents_kind ON brain_documents(kind, status, updated_at);
  CREATE TABLE IF NOT EXISTS brain_document_evidence (
    document_id TEXT NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY(document_id, session_id, seq));
  CREATE INDEX IF NOT EXISTS brain_document_evidence_session ON brain_document_evidence(session_id, document_id);
  CREATE TABLE IF NOT EXISTS brain_document_revisions (
    document_id TEXT NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, snapshot TEXT NOT NULL,
    PRIMARY KEY(document_id, revision));
  CREATE TABLE IF NOT EXISTS brain_note_chunks (
    document_id TEXT NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL, document_revision INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(document_id, entry_id));
  CREATE TABLE IF NOT EXISTS brain_curation_sessions (
    session_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle', error TEXT, updated_at INTEGER NOT NULL);
`;

export class CurationStore {
  constructor(
    readonly db: Database.Database,
    private now = Date.now,
    private onLegacyUpdated?: (id: string, text: string) => void,
  ) {
    db.exec(CURATION_SCHEMA);
    const columns = db.pragma("table_info(brain_documents)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "observed_at")) {
      db.transaction(() => {
        db.exec("ALTER TABLE brain_documents ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0");
        db.exec(`UPDATE brain_documents SET observed_at = MIN(updated_at, COALESCE((
          SELECT MAX(c.ts) FROM brain_document_evidence e
          JOIN t3_capture c ON c.session = e.session_id AND c.seq = e.seq
          WHERE e.document_id = brain_documents.id AND c.ts > 0
        ), created_at))`);
      })();
    }
    // Rebuild the old CHECK constraint without changing document IDs, rowids,
    // evidence, or FTS references. Never run this migration inside a caller transaction.
    const definition = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'brain_documents'").get() as { sql: string };
    if (!definition.sql.includes("'doc'")) {
      if (db.inTransaction) throw new Error("Document kind migration requires an outer connection.");
      const foreignKeys = db.pragma("foreign_keys", { simple: true });
      db.pragma("foreign_keys = OFF");
      try {
        db.transaction(() => {
          db.exec(definition.sql.replace("brain_documents", "brain_documents_next").replace("'notes'", "'notes','doc'"));
          // Copy rowids directly: a later UPDATE can collide with another copied row.
          const names = (db.pragma("table_info(brain_documents)") as Array<{ name: string }>).map(({ name }) => `"${name.replaceAll('"', '""')}"`).join(", ");
          db.exec(`INSERT INTO brain_documents_next(rowid, ${names}) SELECT rowid, ${names} FROM brain_documents`);
          // This trigger belongs to memories, so DROP TABLE does not remove it.
          // Remove it during the swap; the constructor recreates it below.
          db.exec("DROP TRIGGER IF EXISTS brain_documents_legacy_delete");
          db.exec("DROP TABLE brain_documents");
          db.exec("ALTER TABLE brain_documents_next RENAME TO brain_documents");
          db.exec(CURATION_SCHEMA);
          if ((db.pragma("foreign_key_check") as unknown[]).length)
            throw new Error("Document migration would break evidence references.");
        })();
      } finally {
        db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
      }
    }
    if (!(db.pragma("table_info(brain_documents)") as Array<{ name: string }>).some(({ name }) => name === "folder"))
      db.exec("ALTER TABLE brain_documents ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
    const indexed = db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='brain_documents_fts'")
      .get();
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS brain_documents_fts USING fts5(name, description, text,
      content='brain_documents', content_rowid='rowid', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS brain_documents_ai AFTER INSERT ON brain_documents BEGIN
        INSERT INTO brain_documents_fts(rowid,name,description,text) VALUES(new.rowid,new.name,new.description,new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS brain_documents_ad AFTER DELETE ON brain_documents BEGIN
        INSERT INTO brain_documents_fts(brain_documents_fts,rowid,name,description,text) VALUES('delete',old.rowid,old.name,old.description,old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS brain_documents_au AFTER UPDATE OF name,description,text ON brain_documents BEGIN
        INSERT INTO brain_documents_fts(brain_documents_fts,rowid,name,description,text) VALUES('delete',old.rowid,old.name,old.description,old.text);
        INSERT INTO brain_documents_fts(rowid,name,description,text) VALUES(new.rowid,new.name,new.description,new.text);
      END;`);
    if (!indexed) db.exec("INSERT INTO brain_documents_fts(brain_documents_fts) VALUES('rebuild')");
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get()) {
      // The existing human deletion path owns legacy claims and their anchors.
      // Its deletion must also remove the curated presentation of that claim.
      db.exec(`CREATE TRIGGER IF NOT EXISTS brain_documents_legacy_delete AFTER DELETE ON memories BEGIN
        DELETE FROM brain_documents WHERE id = 'mem:' || OLD.id;
      END`);
    }
  }
  get(id: string): BrainDocument | undefined {
    return (
      (this.db.prepare(`SELECT ${COLUMNS}, text FROM brain_documents WHERE id = ?`).get(id) as
        | BrainDocument
        | undefined) ?? this.legacyDocuments(id)[0]
    );
  }
  private legacyDocuments(id?: string): BrainDocument[] {
    if (
      (id && !id.startsWith("mem:")) ||
      !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get()
    )
      return [];
    const rows = this.db
      .prepare(`SELECT id, claim, kind, repo, created_at, updated_at FROM memories
      WHERE status = 'active' AND ('mem:' || id) NOT IN (SELECT id FROM brain_documents)
      ${id ? "AND id = ?" : ""}`)
      .all(...(id ? [id.slice(4)] : [])) as Array<{
      id: string;
      claim: string;
      kind: string;
      repo: string | null;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      id: `mem:${row.id}`,
      kind: "memory",
      name: row.claim.split("\n")[0]!.slice(0, 160),
      description: `Existing ${row.kind} memory`,
      text: redactSecrets(row.claim),
      revision: 0,
      sessionId: "",
      repo: row.repo,
      lifecycle: "standing",
      status: "active",
      halfLifeDays: null,
      createdAt: row.created_at * 1000,
      updatedAt: row.updated_at * 1000,
      observedAt: row.updated_at * 1000,
    }));
  }
  list(
    input: { kind?: DocumentKind; sessionId?: string; includeInactive?: boolean } = {},
  ): BrainDocumentSummary[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.kind) {
      clauses.push("kind = ?");
      values.push(input.kind);
    }
    if (input.sessionId) {
      clauses.push("id IN (SELECT document_id FROM brain_document_evidence WHERE session_id = ?)");
      values.push(input.sessionId);
    }
    if (!input.includeInactive) clauses.push("status != 'superseded'");
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM brain_documents
      ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY updated_at DESC, id`)
      .all(...values) as BrainDocumentSummary[];
  }
  search(
    query: string,
    kind?: DocumentKind,
    limit = 12,
    scope: { notesSessionId?: string | false; includeLegacy?: boolean; excludeMemories?: boolean } = {},
  ): BrainDocumentSummary[] {
    const words = [...new Set(meaningfulTokens(query))].slice(0, 16);
    if (query.trim() && !words.length) return [];
    const clauses = ["status != 'superseded'"];
    if (scope.excludeMemories) clauses.push("kind != 'memory'");
    const parameters: Array<string | number> = [];
    if (kind) {
      clauses.push("kind = ?");
      parameters.push(kind);
    }
    if (scope.notesSessionId === false) clauses.push("kind != 'notes'");
    else if (scope.notesSessionId !== undefined) {
      clauses.push("(kind != 'notes' OR session_id = ?)");
      parameters.push(scope.notesSessionId);
    }
    const where = clauses.join(" AND ");
    const match = words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR ");
    const rows = words.length
      ? (this.db
          .prepare(`SELECT ${COLUMNS}, text FROM brain_documents WHERE rowid IN (
      SELECT rowid FROM brain_documents_fts WHERE brain_documents_fts MATCH ?
      AND EXISTS (SELECT 1 FROM brain_documents WHERE brain_documents.rowid = brain_documents_fts.rowid AND ${where})
      ORDER BY bm25(brain_documents_fts,4,2,1) LIMIT 300)`)
          .all(match, ...parameters) as BrainDocument[])
      : (this.db
          .prepare(
            `SELECT ${COLUMNS},text FROM brain_documents WHERE ${where} ORDER BY updated_at DESC LIMIT 30`,
          )
          .all(...parameters) as BrainDocument[]);
    const indexedIds = new Set(rows.map((row) => row.id));
    if (!scope.excludeMemories && scope.includeLegacy !== false && (!kind || kind === "memory"))
      rows.push(...this.legacyDocuments());
    return rows
      .filter(
        (document) =>
          document.kind !== "notes" ||
          scope.notesSessionId === undefined ||
          document.sessionId === scope.notesSessionId,
      )
      .map((document) => {
        const title = `${document.name} ${document.description}`.toLowerCase();
        const body = document.text.toLowerCase();
        let score = words.length
          ? words.reduce(
              (sum, word) => sum + (title.includes(word) ? 3 : body.includes(word) ? 1 : 0),
              0,
            )
          : 1;
        // FTS stemming can match a word form that literal scoring does not.
        if (words.length && indexedIds.has(document.id)) score = Math.max(score, 0.5);
        if (document.lifecycle === "temporal" && document.halfLifeDays) {
          score *=
            0.5 **
            (Math.max(0, this.now() - document.observedAt) / (document.halfLifeDays * 86_400_000));
        }
        if (document.status === "resolved") score *= 0.7;
        return { document, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || b.document.updatedAt - a.document.updatedAt)
      .slice(0, Math.max(1, Math.min(limit, 30)))
      .map(({ document: { text: _text, ...summary } }) => summary);
  }
  readCapture(sessionId: string, after = 0, through = Number.MAX_SAFE_INTEGER): CaptureRow[] {
    const rows = this.db
      .prepare(
        "SELECT seq, kind, data, ts FROM t3_capture WHERE session = ? AND seq > ? AND seq <= ? ORDER BY seq",
      )
      .all(sessionId, after, through) as Array<{
      seq: number;
      kind: string;
      data: string;
      ts: number;
    }>;
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
  }
  session(sessionId: string): CurationSession {
    return (
      (this.db
        .prepare(`SELECT session_id AS sessionId, last_seq AS lastSeq, status, error, updated_at AS updatedAt
      FROM brain_curation_sessions WHERE session_id = ?`)
        .get(sessionId) as CurationSession | undefined) ?? {
        sessionId,
        lastSeq: 0,
        status: "idle",
        error: null,
        updatedAt: 0,
      }
    );
  }
  setSession(
    sessionId: string,
    status: CurationSession["status"],
    lastSeq?: number,
    error?: string,
  ): void {
    const previous = this.session(sessionId);
    this.db
      .prepare(`INSERT INTO brain_curation_sessions(session_id, last_seq, status, error, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_seq=excluded.last_seq,
      status=excluded.status, error=excluded.error, updated_at=excluded.updated_at`)
      .run(sessionId, lastSeq ?? previous.lastSeq, status, error ?? null, this.now());
  }
  unfinishedSessions(): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT c.session AS id FROM t3_capture c
      JOIN brain_curation_sessions s ON s.session_id = c.session
      WHERE c.seq > COALESCE(s.last_seq, 0) AND c.kind != 'graph'`)
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
  }
  bootstrap(checkpoint: CurationCheckpoint, text: string): BrainDocument {
    const existing = this.get(`notes:${checkpoint.sessionId}`);
    if (existing) return existing;
    return this.save(checkpoint, {
      kind: "notes",
      name: "Conversation notes",
      description: "The original request, captured before extraction.",
      text: `The conversation began with this request:\n\n> ${text.trim().slice(0, 10_000).replaceAll("\n", "\n> ")}${text.length > 10_000 ? "\n\n[Request excerpt; the full message is available in the conversation.]" : ""}`,
      evidence: [checkpoint.through],
    });
  }
  save(checkpoint: CurationCheckpoint, input: SaveDocument): BrainDocument {
    if (input.kind === "memory")
      throw new Error("Standalone memory writes are disabled. Maintain conversation notes, Auto-Docs or Auto-Skills.");
    return this.db.transaction(() => {
      const evidence = [...new Set(input.evidence)];
      let observedAt = 0;
      if (!evidence.length || !evidence.some((seq) => seq > checkpoint.after))
        throw new Error("Cite newly received evidence for this update.");
      for (const seq of evidence) {
        if (!Number.isSafeInteger(seq) || seq > checkpoint.through)
          throw new Error(`Evidence E${seq} is unavailable at this checkpoint.`);
        const captured = this.db
          .prepare("SELECT ts FROM t3_capture WHERE session = ? AND seq = ?")
          .get(checkpoint.sessionId, seq) as { ts: number } | undefined;
        if (!captured) {
          throw new Error(`Evidence E${seq} is unavailable at this checkpoint.`);
        }
        if (Number.isFinite(captured.ts) && captured.ts > 0)
          observedAt = Math.max(observedAt, captured.ts);
      }
      const id =
        input.id ??
        (input.kind === "notes" ? `notes:${checkpoint.sessionId}` : NodeCrypto.randomUUID());
      if (input.kind === "notes" && id !== `notes:${checkpoint.sessionId}`)
        throw new Error("Only this conversation's notes may be changed.");
      const previous = this.get(id);
      const legacy = previous?.revision === 0 && id.startsWith("mem:");
      if (legacy && input.expectedLegacyText !== previous.text)
        throw new Error("Read this existing memory before editing; its source may have changed.");
      if (previous && previous.kind !== input.kind) throw new Error("Document kind cannot change.");
      if (previous && input.expectedRevision !== previous.revision)
        throw new Error(`Document changed. Read revision ${previous.revision} and retry the edit.`);
      if (!previous && input.id && input.kind !== "notes")
        throw new Error("Document not found. Omit id to create a new document.");
      let text = input.text ?? previous?.text;
      if (input.replaceFrom !== undefined) {
        if (!previous || !input.replaceFrom || previous.text.split(input.replaceFrom).length !== 2)
          throw new Error("Replacement must match exactly once. Read the document and retry.");
        text = previous.text.replace(input.replaceFrom, input.replaceTo ?? "");
      }
      if (!text?.trim()) throw new Error("Document text cannot be empty.");
      text = redactSecrets(text);
      const chunks = input.kind === "notes" ? noteChunks(text) : [];
      for (const seq of new Set(chunks.flatMap((chunk) => chunk.evidence))) {
        if (seq > checkpoint.through || !this.db.prepare("SELECT 1 FROM t3_capture WHERE session = ? AND seq = ?").get(checkpoint.sessionId, seq))
          throw new Error(`Inline note evidence E${seq} is unavailable at this checkpoint.`);
      }
      const priorChunks = previous?.kind === "notes" ? noteChunks(previous.text) : [];
      for (const prior of priorChunks.filter((chunk) => chunk.kind === "preference")) {
        if (!chunks.some((chunk) => chunk.id === prior.id))
          throw new Error(`Keep instruction ${prior.id}; revise or explicitly withdraw it instead of silently dropping it.`);
      }
      for (const chunk of chunks.filter((entry) => entry.kind === "preference")) {
        const prior = priorChunks.find((entry) => entry.id === chunk.id);
        if ((!prior && chunk.revision !== 1) || (prior && (chunk.revision < prior.revision || chunk.revision > prior.revision + 1)))
          throw new Error(`Keep ${chunk.id}'s revision stable or advance it by one; new instructions start at 1.`);
        const content = (value: string) => value.replace(/^Sources?:.*$/gim, "").trim();
        if (prior && chunk.revision === prior.revision && content(chunk.text) !== content(prior.text))
          throw new Error(`Instruction ${chunk.id} changed; increment its revision and retain old log references.`);
      }
      for (const reference of new Set(chunks.flatMap((chunk) => chunk.references))) {
        if (![...chunks, ...priorChunks].some((chunk) => `${chunk.id}@${chunk.revision}` === reference) &&
            !this.hasHistoricalInstruction(id, reference))
          throw new Error(`Unknown instruction reference ${reference}; preserve its original revision.`);
      }
      if (text.length > 24_000)
        throw new Error(
          "Consolidate this document below 24K characters; preserve decisions, corrections and useful evidence, not routine exploration.",
        );
      const name = redactSecrets(
        input.name ??
        previous?.name ??
        (input.kind === "notes" ? "Conversation notes" : "")
      ).trim();
      const description = redactSecrets(
        input.description ??
        (input.kind === "notes" && previous
          ? "The task, progress, and corrections preserved from this conversation."
          : (previous?.description ?? ""))
      ).trim();
      if (!name || name.length > 160 || description.length > 600)
        throw new Error("Use a short name and a one-line description.");
      if (input.kind === "skill" && !description)
        throw new Error("Skills need a description explaining when to use them.");
      if (input.kind === "skill") {
        const slug =
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 64)
            .replace(/-+$/, "") || "brain-skill";
        text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
        text = `---\nname: ${JSON.stringify(slug)}\ndescription: ${JSON.stringify(description)}\n---\n\n${text}\n`;
        if (text.length > 24_000)
          throw new Error("Consolidate this skill below 24K characters including its frontmatter.");
      }
      const now = this.now();
      const folder = redactSecrets(input.folder ?? previous?.folder ?? "").split("/").map((part) => part.trim()).join("/");
      if (folder.length > 240 || (folder && (input.kind !== "doc" || folder.split("/").some((part) => !part || part === "." || part === ".."))))
        throw new Error("Use a topic folder path for Auto-Docs only, e.g. Company/Mission.");
      const lifecycle = input.lifecycle ?? previous?.lifecycle ?? "standing";
      const halfLifeDays =
        lifecycle === "temporal" ? (input.halfLifeDays ?? previous?.halfLifeDays ?? 30) : null;
      if (
        halfLifeDays !== null &&
        (!Number.isFinite(halfLifeDays) || halfLifeDays < 1 || halfLifeDays > 3650)
      )
        throw new Error("Temporal half-life must be between 1 and 3650 days.");
      const document: BrainDocument = {
        id,
        kind: input.kind,
        folder,
        name,
        description,
        text,
        revision: (previous?.revision ?? 0) + 1,
        sessionId: previous?.sessionId || checkpoint.sessionId,
        repo: previous?.repo ?? checkpoint.repo,
        lifecycle,
        status: input.status ?? previous?.status ?? "active",
        halfLifeDays,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        // Reprocessing old evidence must not renew the age of temporary context.
        observedAt: Math.min(
          now,
          Math.max(previous?.observedAt ?? 0, observedAt || previous?.createdAt || now),
        ),
      };
      if (
        previous &&
        previous.text === document.text &&
        previous.name === document.name &&
        previous.description === document.description &&
        (previous.folder ?? "") === folder &&
        previous.lifecycle === document.lifecycle &&
        previous.status === document.status &&
        previous.halfLifeDays === document.halfLifeDays
      )
        throw new Error("No meaningful change; leave this document as it is.");
      this.db
        .prepare(`INSERT INTO brain_documents(id, kind, folder, name, description, text, revision, session_id,
        repo, lifecycle, status, half_life_days, created_at, updated_at, observed_at)
        VALUES (@id, @kind, @folder, @name, @description, @text, @revision, @sessionId, @repo, @lifecycle, @status,
        @halfLifeDays, @createdAt, @updatedAt, @observedAt) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
        folder=excluded.folder, description=excluded.description, text=excluded.text, revision=excluded.revision, lifecycle=excluded.lifecycle,
        status=excluded.status, half_life_days=excluded.half_life_days, updated_at=excluded.updated_at,
        observed_at=excluded.observed_at`)
        .run(document);
      if (id.startsWith("mem:")) {
        // Existing graph memory cards and search read this same canonical claim.
        // Preserve their anchors/strength while the document carries new prose and provenance.
        this.db
          .prepare(
            "UPDATE memories SET claim = ?, updated_at = ?, status = ?, embedding = NULL WHERE id = ?",
          )
          .run(
            document.text,
            Math.floor(now / 1000),
            document.status === "superseded" ? "sunk" : "active",
            id.slice(4),
          );
        this.onLegacyUpdated?.(id.slice(4), document.text);
      }
      const cite = this.db.prepare(
        "INSERT OR IGNORE INTO brain_document_evidence(document_id, session_id, seq) VALUES (?, ?, ?)",
      );
      for (const seq of evidence) cite.run(id, checkpoint.sessionId, seq);
      const saveRevision = this.db.prepare("INSERT OR IGNORE INTO brain_document_revisions(document_id, revision, snapshot) VALUES (?, ?, ?)");
      if (previous && previous.revision > 0) saveRevision.run(id, previous.revision, JSON.stringify(previous));
      saveRevision.run(id, document.revision, JSON.stringify(document));
      if (document.kind === "notes") {
        // Only the current note revision participates in the active chunk index.
        this.db.prepare("DELETE FROM brain_note_chunks WHERE document_id = ?").run(id);
        const insert = this.db.prepare("INSERT INTO brain_note_chunks VALUES (?, ?, ?, ?)");
        for (const chunk of chunks) insert.run(id, chunk.id, document.revision, JSON.stringify(chunk));
      }
      return document;
    })();
  }
  evidence(id: string): Array<{ sessionId: string; seq: number }> {
    return this.db
      .prepare(
        "SELECT session_id AS sessionId, seq FROM brain_document_evidence WHERE document_id = ? ORDER BY session_id, seq",
      )
      .all(id) as Array<{ sessionId: string; seq: number }>;
  }
  revision(id: string, revision: number): BrainDocument | undefined {
    const current = this.get(id);
    if (current?.revision === revision) return current;
    const row = this.db.prepare("SELECT snapshot FROM brain_document_revisions WHERE document_id = ? AND revision = ?").get(id, revision) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as BrainDocument : undefined;
  }
  chunks(id: string): NoteChunk[] {
    const document = this.get(id);
    if (document?.kind !== "notes") return [];
    const rows = this.db.prepare("SELECT payload FROM brain_note_chunks WHERE document_id = ? AND document_revision = ? ORDER BY rowid").all(id, document.revision) as Array<{ payload: string }>;
    return rows.length ? rows.map(({ payload }) => JSON.parse(payload) as NoteChunk) : noteChunks(document.text);
  }
  private hasHistoricalInstruction(id: string, reference: string): boolean {
    const rows = this.db.prepare("SELECT snapshot FROM brain_document_revisions WHERE document_id = ? ORDER BY revision DESC").iterate(id) as Iterable<{ snapshot: string }>;
    for (const { snapshot } of rows) {
      const document = JSON.parse(snapshot) as BrainDocument;
      if (document.kind === "notes" && noteChunks(document.text).some((chunk) => `${chunk.id}@${chunk.revision}` === reference)) return true;
    }
    return false;
  }
}

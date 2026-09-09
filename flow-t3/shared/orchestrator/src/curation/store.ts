import * as NodeCrypto from "node:crypto";
import type Database from "better-sqlite3";
import { meaningfulTokens } from "../memory/search-query.js";
import { redactSecrets } from "./transcript.js";
import type {
  BrainDocument,
  BrainDocumentSummary,
  CaptureRow,
  CurationCheckpoint,
  CurationSession,
  DocumentKind,
  SaveDocument,
} from "./types.js";

const COLUMNS = `id, kind, name, description, revision, session_id AS sessionId, repo,
  lifecycle, status, half_life_days AS halfLifeDays, created_at AS createdAt, updated_at AS updatedAt,
  observed_at AS observedAt`;
export const CURATION_SCHEMA = `
  CREATE INDEX IF NOT EXISTS t3_capture_session_sequence ON t3_capture(session, seq);
  CREATE TABLE IF NOT EXISTS brain_documents (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('notes','memory','skill')),
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
    scope: { notesSessionId?: string | false; includeLegacy?: boolean } = {},
  ): BrainDocumentSummary[] {
    const words = [...new Set(meaningfulTokens(query))].slice(0, 16);
    if (query.trim() && !words.length) return [];
    const clauses = ["status != 'superseded'"];
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
    if (scope.includeLegacy !== false && (!kind || kind === "memory"))
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
      if (input.kind === "memory" && text.length > 6000)
        throw new Error(
          "Keep a memory below 6K characters and focused on one reusable question. Consolidate repetitive evidence; conversation progress belongs in notes.",
        );
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
        previous.lifecycle === document.lifecycle &&
        previous.status === document.status &&
        previous.halfLifeDays === document.halfLifeDays
      )
        throw new Error("No meaningful change; leave this document as it is.");
      this.db
        .prepare(`INSERT INTO brain_documents(id, kind, name, description, text, revision, session_id,
        repo, lifecycle, status, half_life_days, created_at, updated_at, observed_at)
        VALUES (@id, @kind, @name, @description, @text, @revision, @sessionId, @repo, @lifecycle, @status,
        @halfLifeDays, @createdAt, @updatedAt, @observedAt) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
        description=excluded.description, text=excluded.text, revision=excluded.revision, lifecycle=excluded.lifecycle,
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
}

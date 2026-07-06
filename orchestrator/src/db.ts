// db.ts — SQLite setup via better-sqlite3. Single connection, synchronous API.
// All tables created here; callers import `db` and run statements directly.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const DB_PATH = process.env.DB_PATH ?? resolve(__dirname, "../data/flow.db");

// Where file-based logs (opencode job transcripts) live. In-memory test DBs
// have no data dir — callers must check for null and skip file logging.
export const DB_DIR = DB_PATH === ":memory:" ? null : resolve(DB_PATH, "..");

// Ensure data dir exists before opening
mkdirSync(resolve(DB_PATH, ".."), { recursive: true });

export const db = new Database(DB_PATH);

// WAL mode for concurrent reads alongside writes
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  -- ------------------------------------------------------------------
  -- Core event + job tables
  -- ------------------------------------------------------------------

  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    type        TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    payload     TEXT NOT NULL,   -- JSON
    workspace   TEXT,
    classification_json TEXT,  -- persisted ClassificationResult; enables propose→approve replay
    received_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,   -- index_repo | enrich | answer
    input       TEXT NOT NULL,   -- JSON
    status      TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed
    result_json TEXT,
    repo        TEXT,            -- for per-repo mutex
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ------------------------------------------------------------------
  -- Audit log — one row per classification and per action
  -- ------------------------------------------------------------------

  CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT,
    classification  TEXT,
    confidence      REAL,
    action          TEXT,   -- e.g. graphwrite | contextblock | propose | suppressed
    target          TEXT,
    status          TEXT,
    detail          TEXT,   -- JSON or freeform
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ------------------------------------------------------------------
  -- Config: key/value store for policy matrix and general settings
  -- ------------------------------------------------------------------

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL  -- JSON
  );

  -- ------------------------------------------------------------------
  -- Outbox: pending external side-effects for propose mode or simulator
  -- assertions. Real adapters drain this; tests assert on it.
  -- ------------------------------------------------------------------

  CREATE TABLE IF NOT EXISTS outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT,
    action_type TEXT NOT NULL,  -- slack_post | linear_write | dm | etc.
    payload     TEXT NOT NULL,  -- JSON — what would have been sent
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|failed
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    sent_at     INTEGER
  );

  -- ------------------------------------------------------------------
  -- Corpus: searchable evidence tier (FTS5 virtual tables)
  -- ------------------------------------------------------------------

  CREATE TABLE IF NOT EXISTS slack_messages (
    id          TEXT PRIMARY KEY,
    workspace   TEXT,
    channel     TEXT,
    user_id     TEXT,
    text        TEXT NOT NULL,
    ts          TEXT NOT NULL,
    thread_ts   TEXT,
    permalink   TEXT,
    inserted_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS slack_messages_fts USING fts5(
    id UNINDEXED, text, channel, user_id,
    content='slack_messages', content_rowid='rowid'
  );

  CREATE TABLE IF NOT EXISTS linear_tickets (
    id          TEXT PRIMARY KEY,
    identifier  TEXT,
    title       TEXT NOT NULL,
    description TEXT,
    state       TEXT,
    assignee    TEXT,
    labels      TEXT,  -- JSON array
    url         TEXT,
    updated_at  INTEGER,
    inserted_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS linear_tickets_fts USING fts5(
    id UNINDEXED, title, description, identifier,
    content='linear_tickets', content_rowid='rowid'
  );

  CREATE TABLE IF NOT EXISTS meeting_segments (
    id          TEXT PRIMARY KEY,
    meeting_id  TEXT NOT NULL,
    speaker     TEXT,
    text        TEXT NOT NULL,
    start_ms    INTEGER,
    end_ms      INTEGER,
    inserted_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS meeting_segments_fts USING fts5(
    id UNINDEXED, text, speaker, meeting_id,
    content='meeting_segments', content_rowid='rowid'
  );

  -- ------------------------------------------------------------------
  -- Thread sessions: thread_ts <-> opencode session id (G10)
  -- SESSION-PER-CHAT model: once a thread is bound all its messages
  -- skip the classifier and continue the session.
  -- ------------------------------------------------------------------

  CREATE TABLE IF NOT EXISTS thread_sessions (
    thread_key    TEXT PRIMARY KEY,  -- "workspace:channel:thread_ts"
    session_id    TEXT NOT NULL,
    job_id        TEXT,
    status        TEXT NOT NULL DEFAULT 'active',  -- active|dormant
    last_activity INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ------------------------------------------------------------------
  -- Poll cursors: one row per (source, resource) pair.
  -- Project isolation is via the per-project DB file (each project =
  -- own flow.db), so no project column is needed.
  --
  -- source   : adapter name, e.g. "github", "linear", "fireflies"
  -- resource : adapter-specific key, e.g. "owner/repo" or "team_id"
  --            or the special value "_all" for source-level cursors
  -- cursor   : opaque string; interpretation is adapter-defined
  --            (ISO timestamp for Linear/Fireflies, HEAD SHA for GitHub)
  -- last_poll_at : unix epoch seconds of last successful poll attempt
  -- status   : "idle" | "catching_up" | "error"
  -- ------------------------------------------------------------------

  CREATE TABLE IF NOT EXISTS poll_cursors (
    source       TEXT NOT NULL,
    resource     TEXT NOT NULL,
    cursor       TEXT NOT NULL DEFAULT '',
    last_poll_at INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'idle',
    PRIMARY KEY (source, resource)
  );

  -- ------------------------------------------------------------------
  -- LLM observability: one row per live model interaction, so wrong
  -- classifications and misbehaving agent runs are debuggable after the
  -- fact. prompt/response are size-capped at write time. Full opencode
  -- job transcripts live as files under DB_DIR/job-logs/<job_id>.jsonl.
  -- ------------------------------------------------------------------

  CREATE TABLE IF NOT EXISTS llm_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL DEFAULT (unixepoch()),
    kind       TEXT NOT NULL,     -- classifier | opencode_job
    ref        TEXT,              -- event_id or job_id
    model      TEXT,
    attempt    INTEGER DEFAULT 1,
    ok         INTEGER NOT NULL,  -- 1 | 0
    latency_ms INTEGER,
    error      TEXT,
    prompt     TEXT,
    response   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_llm_log_ref ON llm_log(ref);
`);

// FTS triggers to keep virtual tables in sync with base tables
db.exec(`
  CREATE TRIGGER IF NOT EXISTS slack_messages_ai AFTER INSERT ON slack_messages BEGIN
    INSERT INTO slack_messages_fts(rowid, id, text, channel, user_id)
      VALUES (new.rowid, new.id, new.text, new.channel, new.user_id);
  END;

  CREATE TRIGGER IF NOT EXISTS slack_messages_ad AFTER DELETE ON slack_messages BEGIN
    INSERT INTO slack_messages_fts(slack_messages_fts, rowid, id, text, channel, user_id)
      VALUES ('delete', old.rowid, old.id, old.text, old.channel, old.user_id);
  END;

  CREATE TRIGGER IF NOT EXISTS slack_messages_au AFTER UPDATE ON slack_messages BEGIN
    INSERT INTO slack_messages_fts(slack_messages_fts, rowid, id, text, channel, user_id)
      VALUES ('delete', old.rowid, old.id, old.text, old.channel, old.user_id);
    INSERT INTO slack_messages_fts(rowid, id, text, channel, user_id)
      VALUES (new.rowid, new.id, new.text, new.channel, new.user_id);
  END;

  CREATE TRIGGER IF NOT EXISTS linear_tickets_ai AFTER INSERT ON linear_tickets BEGIN
    INSERT INTO linear_tickets_fts(rowid, id, title, description, identifier)
      VALUES (new.rowid, new.id, new.title, new.description, new.identifier);
  END;

  CREATE TRIGGER IF NOT EXISTS linear_tickets_ad AFTER DELETE ON linear_tickets BEGIN
    INSERT INTO linear_tickets_fts(linear_tickets_fts, rowid, id, title, description, identifier)
      VALUES ('delete', old.rowid, old.id, old.title, old.description, old.identifier);
  END;

  CREATE TRIGGER IF NOT EXISTS linear_tickets_au AFTER UPDATE ON linear_tickets BEGIN
    INSERT INTO linear_tickets_fts(linear_tickets_fts, rowid, id, title, description, identifier)
      VALUES ('delete', old.rowid, old.id, old.title, old.description, old.identifier);
    INSERT INTO linear_tickets_fts(rowid, id, title, description, identifier)
      VALUES (new.rowid, new.id, new.title, new.description, new.identifier);
  END;

  CREATE TRIGGER IF NOT EXISTS meeting_segments_ai AFTER INSERT ON meeting_segments BEGIN
    INSERT INTO meeting_segments_fts(rowid, id, text, speaker, meeting_id)
      VALUES (new.rowid, new.id, new.text, new.speaker, new.meeting_id);
  END;

  CREATE TRIGGER IF NOT EXISTS meeting_segments_ad AFTER DELETE ON meeting_segments BEGIN
    INSERT INTO meeting_segments_fts(meeting_segments_fts, rowid, id, text, speaker, meeting_id)
      VALUES ('delete', old.rowid, old.id, old.text, old.speaker, old.meeting_id);
  END;

  CREATE TRIGGER IF NOT EXISTS meeting_segments_au AFTER UPDATE ON meeting_segments BEGIN
    INSERT INTO meeting_segments_fts(meeting_segments_fts, rowid, id, text, speaker, meeting_id)
      VALUES ('delete', old.rowid, old.id, old.text, old.speaker, old.meeting_id);
    INSERT INTO meeting_segments_fts(rowid, id, text, speaker, meeting_id)
      VALUES (new.rowid, new.id, new.text, new.speaker, new.meeting_id);
  END;
`);

// ------------------------------------------------------------------
// poll_cursors: one row per (source, resource), project-scoped by DB file.
// resource is "" for source-level pollers (github, linear, fireflies).
// status: ok | error | catching_up | disabled | idle
// detail: freeform string for last-run information or error message.
// ------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS poll_cursors (
    source       TEXT NOT NULL,
    resource     TEXT NOT NULL DEFAULT '',
    cursor       TEXT NOT NULL DEFAULT '',
    last_poll_at INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'ok',
    detail       TEXT,
    PRIMARY KEY (source, resource)
  );
`);

// Migration: add detail column if it doesn't exist (existing DBs may lack it)
try {
  db.exec("ALTER TABLE poll_cursors ADD COLUMN detail TEXT");
} catch {
  // column already exists
}

// Lightweight migrations for databases created before these columns existed.
try {
  db.exec("ALTER TABLE events ADD COLUMN classification_json TEXT");
} catch {
  // column already exists
}

try {
  db.exec("ALTER TABLE jobs ADD COLUMN notify_count INTEGER NOT NULL DEFAULT 0");
} catch {
  // column already exists
}

try {
  db.exec("ALTER TABLE jobs ADD COLUMN session_id TEXT");
} catch {
  // column already exists
}

export default db;

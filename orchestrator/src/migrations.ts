// Versioned SQLite migrations, tracked with SQLite's native PRAGMA user_version.
//
// How it composes with db.ts:
//   - db.ts always runs the full baseline schema (CREATE ... IF NOT EXISTS), so
//     a FRESH database already matches the latest shape — it just gets stamped
//     with the latest version, no migrations run.
//   - An EXISTING database walks every migration with id > its stored version,
//     each inside a transaction, stamping user_version as it goes.
//
// Rules for adding a migration:
//   - Append only, next integer id — never renumber or edit a shipped one.
//   - Also update the baseline schema in db.ts so fresh DBs are born current.
//   - One-way schema changes only. Convergent enrichment (backfills that can
//     re-run) belongs in a boot reconciler, not here — see graph-gateway's
//     reconcile.ts for the pattern.
//
// Migrations 1-4 predate versioning (they shipped as tolerant try/catch ALTERs
// at module load). Every existing DB already has those columns but reports
// user_version 0, so these four must stay duplicate-tolerant. Future
// migrations should be strict: a real failure must crash boot loudly, not be
// swallowed.

import type Database from "better-sqlite3";

type DB = Database.Database;

export interface Migration {
  id: number;
  name: string;
  up: (db: DB) => void;
}

// ALTER TABLE ADD COLUMN that tolerates the column already existing (needed
// for the pre-versioning migrations only — see header).
function addColumn(db: DB, sql: string): void {
  try {
    db.exec(sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "poll_cursors: add detail column",
    up: (db) => addColumn(db, "ALTER TABLE poll_cursors ADD COLUMN detail TEXT"),
  },
  {
    id: 2,
    name: "events: add classification_json column",
    up: (db) => addColumn(db, "ALTER TABLE events ADD COLUMN classification_json TEXT"),
  },
  {
    id: 3,
    name: "jobs: add notify_count column",
    up: (db) => addColumn(db, "ALTER TABLE jobs ADD COLUMN notify_count INTEGER NOT NULL DEFAULT 0"),
  },
  {
    id: 4,
    name: "jobs: add session_id column",
    up: (db) => addColumn(db, "ALTER TABLE jobs ADD COLUMN session_id TEXT"),
  },
  {
    id: 5,
    name: "corrections: agent-flagged graph inaccuracies awaiting indexer verification",
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS corrections (
          id          TEXT PRIMARY KEY,
          target_ids  TEXT NOT NULL,
          reason      TEXT NOT NULL,
          evidence    TEXT,
          repo        TEXT,
          actor       TEXT,
          session     TEXT,
          graph_name  TEXT,
          status      TEXT NOT NULL DEFAULT 'pending',
          job_id      TEXT,
          resolution  TEXT,
          created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `),
  },
  {
    id: 6,
    name: "branch_notes: Flow-side working memory scoped to repo+branch",
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS branch_notes (
          id          TEXT PRIMARY KEY,
          repo        TEXT NOT NULL,
          branch      TEXT NOT NULL,
          kind        TEXT NOT NULL DEFAULT 'note',
          text        TEXT NOT NULL,
          anchor_hint TEXT,
          actor       TEXT,
          session     TEXT,
          status      TEXT NOT NULL DEFAULT 'active',
          embedding   BLOB,
          created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_branch_notes_repo_branch ON branch_notes(repo, branch, status);
      `),
  },
  {
    id: 7,
    name: "agent_sessions: session-diff snapshot columns (start_sha, start_untracked, worktree_id)",
    up: (db) => {
      // SEQUENCING HAZARD: agent_sessions is NOT in db.ts's baseline — it's
      // created at runtime.ts module load, which happens AFTER migrations run
      // (db.ts → migrate() at import). So a DB that predates the agents feature
      // has no agent_sessions table yet, and bare ALTERs would crash boot.
      // Create the CURRENT (pre-change) shape first: a no-op when the table
      // already exists (older agents DB), and the owner of its creation when it
      // doesn't. Either way the ALTERs below then land on a real table with the
      // new columns absent, so they succeed strictly (no duplicate-column
      // tolerance needed — migrations 5+ are strict; see header).
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          backend TEXT NOT NULL,
          repo TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          acp_session_id TEXT,
          stop_reason TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec("ALTER TABLE agent_sessions ADD COLUMN start_sha TEXT");
      db.exec("ALTER TABLE agent_sessions ADD COLUMN start_untracked TEXT");
      db.exec("ALTER TABLE agent_sessions ADD COLUMN worktree_id TEXT");
    },
  },
  {
    id: 8,
    name: "memory v1: observations + memories + FTS5, distill bookkeeping",
    up: (db) => {
      // Keep this schema IDENTICAL to the baseline block in db.ts (MEMORY_SCHEMA
      // there) — fresh DBs are born from the baseline and skip this migration,
      // so drift between the two would go unnoticed until an existing DB upgrades.
      db.exec(MEMORY_SCHEMA);
      db.exec(MEMORY_TRIGGERS);
      // Idle-sweep bookkeeping: the highest transcript seq the distiller has
      // already consumed for a session. NULL = never distilled.
      db.exec("ALTER TABLE agent_sessions ADD COLUMN last_distilled_seq INTEGER");
    },
  },
  {
    id: 9,
    name: "memory v1: anchors join table (item ↔ graph node)",
    up: (db) => {
      // Keep byte-identical to ANCHORS_SCHEMA in db.ts (see migration 8 note).
      db.exec(ANCHORS_SCHEMA);
    },
  },
  {
    id: 10,
    name: "index_log: durable indexer lifecycle trail",
    up: (db) => {
      // Keep byte-identical to INDEX_LOG_SCHEMA in db.ts (see migration 8 note).
      db.exec(INDEX_LOG_SCHEMA);
    },
  },
];

// Indexer lifecycle trail — one row per transition (enqueued, parked,
// superseded, started, done, failed, recovered, watch, removed) so
// self-deployers can reconstruct what the indexer did and why without
// shell access to the orchestrator log. Rows are append-only; detail is
// JSON (branch, commit, duration_ms, error, ...). Read via GET /v1/index-log.
export const INDEX_LOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS index_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    repo       TEXT NOT NULL,
    event      TEXT NOT NULL,
    job_id     TEXT,
    detail     TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_index_log_repo ON index_log(repo, id);
`;

// Anchors: the join between a memory/observation (flow.db PRIMARY) and a graph
// node (a rebuildable projection). flow.db owns the edge; any graph
// representation is derivable. item_type distinguishes distilled memories from
// raw corpus observations (linear/slack) so a node's headline index can pull
// the right kind. node_id is the graph node id string (e.g. 'svc:users',
// 'api:dashboard:GET /agents'); source records HOW the edge was inferred
// (deterministic file match vs. semantic). resolved_at is the epoch the edge
// was last (re)resolved — re-resolution deletes+reinserts. Cap of 3 anchors per
// item is enforced in code, not schema. UNIQUE keeps re-resolution idempotent.
export const ANCHORS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS anchors (
    id          TEXT PRIMARY KEY,
    item_type   TEXT NOT NULL,   -- 'memory' | 'observation'
    item_id     TEXT NOT NULL,
    node_id     TEXT NOT NULL,   -- graph node id string
    source      TEXT NOT NULL,   -- 'files' | 'semantic'
    resolved_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(item_type, item_id, node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_anchors_item ON anchors(item_type, item_id);
  CREATE INDEX IF NOT EXISTS idx_anchors_node ON anchors(node_id);
`;

// Memory v1 storage. observations = raw per-session/corpus claims (the corpus,
// FTS-mirrored); memories = consolidated canonical claims an observation attaches
// to. Both carry a 768-dim Gemma embedding BLOB (see embed.ts). repo_family is
// the normalized repo name (suffixes like -backend stripped) — the retrieval
// hard gate keys on it. Kept in one exported string so db.ts's baseline and
// migration 8 stay byte-identical.
export const MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS observations (
    id             TEXT PRIMARY KEY,
    source         TEXT NOT NULL,   -- session | slack | linear | meeting
    repo           TEXT,
    repo_family    TEXT,            -- normalized repo (e.g. foo-backend -> foo); NULL = match-all
    branch         TEXT,
    session_id     TEXT,
    claim          TEXT NOT NULL,
    kind           TEXT NOT NULL,   -- decision|constraint|gotcha|how_to|preference|plan
    source_weight  TEXT NOT NULL DEFAULT 'agent_inferred', -- user_stated|agent_inferred|error_proven
    context_files  TEXT,            -- JSON array
    retrieval_keys TEXT,            -- JSON array
    embedding      BLOB,
    memory_id      TEXT,            -- FK -> memories.id, nullable until consolidated
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_observations_family ON observations(repo_family, memory_id);
  CREATE INDEX IF NOT EXISTS idx_observations_memory ON observations(memory_id);

  CREATE TABLE IF NOT EXISTS memories (
    id                 TEXT PRIMARY KEY,
    claim              TEXT NOT NULL,   -- canonical
    kind               TEXT NOT NULL,
    repo               TEXT,
    repo_family        TEXT,
    strength           REAL NOT NULL DEFAULT 0,
    evidence_count     INTEGER NOT NULL DEFAULT 0,
    people_count       INTEGER NOT NULL DEFAULT 0,
    contradiction_count INTEGER NOT NULL DEFAULT 0,
    last_reinforced_at INTEGER,
    status             TEXT NOT NULL DEFAULT 'active', -- active | sunk
    embedding          BLOB,
    retrieval_keys     TEXT,            -- JSON array (union of attached observations)
    max_source_weight  TEXT NOT NULL DEFAULT 'agent_inferred',
    created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_memories_family ON memories(repo_family, status);

  CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    id UNINDEXED, claim, retrieval_keys,
    content='observations', content_rowid='rowid'
  );
`;

// FTS triggers mirroring the corpus.ts pattern — kept out of MEMORY_SCHEMA so
// they can be created once (baseline + migration both call ensureMemoryTriggers).
export const MEMORY_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, id, claim, retrieval_keys)
      VALUES (new.rowid, new.id, new.claim, new.retrieval_keys);
  END;
  CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, id, claim, retrieval_keys)
      VALUES ('delete', old.rowid, old.id, old.claim, old.retrieval_keys);
  END;
  CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, id, claim, retrieval_keys)
      VALUES ('delete', old.rowid, old.id, old.claim, old.retrieval_keys);
    INSERT INTO observations_fts(rowid, id, claim, retrieval_keys)
      VALUES (new.rowid, new.id, new.claim, new.retrieval_keys);
  END;
`;

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0);

// Run pending migrations. `fresh` = the DB had no tables before the baseline
// schema ran this boot (detected by db.ts), so it's already at latest shape.
export function migrate(db: DB, opts: { fresh: boolean }): void {
  const current = db.pragma("user_version", { simple: true }) as number;

  if (opts.fresh) {
    if (current < LATEST_VERSION) db.pragma(`user_version = ${LATEST_VERSION}`);
    return;
  }

  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.id}`);
    })();
    console.log(`[db] migration ${m.id} applied: ${m.name}`);
  }
}

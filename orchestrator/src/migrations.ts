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
];

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

#!/usr/bin/env node
// backfill-corpus-observations.mjs — one-shot: turn existing slack_messages and
// linear_tickets rows into memory `observations` so search_memory sees history
// that predates the corpus-enrichment write path.
//
// Idempotent: skips a row whose observation already exists (matched on a stable
// synthetic id derived from source+source_id). Embeddings are left NULL here —
// this script does not load the model; the observations are still FTS-searchable
// immediately and can be re-embedded by a later maintenance pass. (Running the
// live orchestrator with the enrichment path is the embedded route; this script
// is the catch-up for pre-existing rows.)
//
// Usage:
//   DB_PATH=/path/to/flow.db node scripts/backfill-corpus-observations.mjs [--limit N] [--dry]
//
// SAFETY: point DB_PATH at the target DB explicitly. Never runs against a DB it
// wasn't told about; refuses if DB_PATH is unset.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const DB_PATH = process.env.DB_PATH;
if (!DB_PATH) {
  console.error("Refusing to run: set DB_PATH to the target flow.db explicitly.");
  process.exit(1);
}
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const limIdx = argv.indexOf("--limit");
const limit = limIdx >= 0 ? Number(argv[limIdx + 1]) : Infinity;

// repo_family normalization must match orchestrator/src/memory/repo-family.ts.
const SUFFIXES = ["backend","frontend","api","server","client","web","app","service","svc","ui","worker","core","lib","sdk","infra","mobile"];
function repoFamily(repo) {
  if (!repo) return null;
  let name = String(repo).trim().toLowerCase();
  if (!name) return null;
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  name = name.replace(/\.git$/, "");
  for (const s of SUFFIXES) {
    const re = new RegExp(`[-_]${s}$`);
    if (re.test(name)) { name = name.replace(re, ""); break; }
  }
  return name || null;
}

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

// A synthetic, stable observation id per corpus row so re-runs are idempotent.
const existsStmt = db.prepare("SELECT 1 FROM observations WHERE id = ?");
const insertStmt = db.prepare(`
  INSERT INTO observations
    (id, source, repo, repo_family, branch, session_id, claim, kind, source_weight,
     context_files, retrieval_keys, embedding, memory_id)
  VALUES (@id, @source, @repo, @repo_family, NULL, NULL, @claim, 'gotcha', 'user_stated',
          NULL, NULL, NULL, NULL)
`);

function backfill(rows, source, textOf, repoOf) {
  let inserted = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const id = `backfill:${source}:${r.id}`;
      if (existsStmt.get(id)) { skipped++; continue; }
      const text = (textOf(r) || "").trim();
      if (!text) { skipped++; continue; }
      const repo = repoOf(r) ?? null;
      if (!dry) {
        insertStmt.run({ id, source, repo, repo_family: repoFamily(repo), claim: text.slice(0, 1000) });
      }
      inserted++;
    }
  });
  tx();
  return { inserted, skipped };
}

const slackRows = db.prepare("SELECT id, text FROM slack_messages LIMIT ?").all(Number.isFinite(limit) ? limit : -1);
const slack = backfill(slackRows, "slack", (r) => r.text, () => null);

const linearRows = db.prepare("SELECT id, identifier, title, description FROM linear_tickets LIMIT ?").all(Number.isFinite(limit) ? limit : -1);
const linear = backfill(
  linearRows,
  "linear",
  (r) => [r.title, r.description].filter(Boolean).join(" — "),
  () => null,
);

console.log(`${dry ? "[dry] " : ""}slack:  +${slack.inserted} (skipped ${slack.skipped})`);
console.log(`${dry ? "[dry] " : ""}linear: +${linear.inserted} (skipped ${linear.skipped})`);
db.close();

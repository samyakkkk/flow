// _live_retrieval.ts — re-run retrieval with CLEAN queries against the existing
// temp DB, to cleanly separate the FTS path from the cosine path and exercise
// the 0.55 silence gate. Requires the gateway running (query embedding hop).

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import db from "./src/db.js";
import { searchMemory } from "./src/memory/search.js";

const OUT = process.env.LIVE_OUT ?? "/tmp/memlive-out";
mkdirSync(OUT, { recursive: true });
const REPO = "flow-orchestrator";

function ftsQuery(query: string): string {
  const tokens = query.match(/[A-Za-z0-9_./:-]+/g) ?? [];
  const quoted = tokens.filter((t) => t.length >= 2).map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(" OR ");
}
function ftsHitCount(q: string): number {
  const m = ftsQuery(q);
  if (!m) return 0;
  try {
    return (db.prepare(`SELECT COUNT(*) c FROM observations_fts WHERE observations_fts MATCH ?`).get(m) as any).c;
  } catch {
    return -1;
  }
}

// (a) SEMANTIC paraphrase — deliberately shares NO token with the claim/keys.
//     Claim/keys contain: sqlite,database,locked,wal,checkpoint,db,singleton,
//     better-sqlite3,concurrent,deadlock,distiller,store,memory,writes,shared,
//     insertobservation,session,close,the,is,go,file,second,connection.
//     This query avoids all of them (uses "one persistent handle","parallel
//     tasks","embedded store","stalls").
// (b) VERBATIM error string — proves FTS bypass of the silence gate.
// (c) UNRELATED same-family — avoids EVERY claim token INCLUDING stopwords like
//     "the"/"is", so FTS returns nothing and the cosine floor decides.
const queries: Array<{ label: string; query: string }> = [
  {
    label: "a) SEMANTIC paraphrase (zero shared tokens -> pure cosine)",
    query: "one persistent handle prevents parallel tasks from stalling our embedded key-value engine",
  },
  { label: "b) VERBATIM error string (FTS bypass)", query: "SqliteError: database is locked" },
  {
    label: "c) UNRELATED same-family (silence-gate drop)",
    query: "rotating avatar images for user profile cards on a marketing landing page",
  },
];

async function main() {
  const results: any[] = [];
  for (const q of queries) {
    const preFts = ftsHitCount(q.query);
    const t0 = Date.now();
    const res = await searchMemory({ query: q.query, repo: REPO, limit: 8 });
    const ms = Date.now() - t0;
    console.log(`\nQUERY ${q.label}`);
    console.log(`  "${q.query}"`);
    console.log(`  FTS raw-hit-count (before ranking): ${preFts}`);
    console.log(`  -> ${res.memories.length} memory hit(s) in ${ms}ms (internal ${res.durationMs}ms)`);
    for (const m of res.memories) {
      console.log(
        `     cosine=${m.cosine.toFixed(4)} score=${m.score.toFixed(4)} fts=${m.ftsHit} tier=${m.strengthTier} claim="${m.claim.slice(0, 70)}…"`,
      );
    }
    if (res.memories.length === 0) console.log("     (no memories — silence gate dropped everything)");
    results.push({
      label: q.label,
      query: q.query,
      ftsRawHitCount: preFts,
      latencyMs: ms,
      durationMs: res.durationMs,
      memories: res.memories.map((m) => ({ cosine: m.cosine, score: m.score, ftsHit: m.ftsHit, claim: m.claim })),
    });
  }
  writeFileSync(path.join(OUT, "retrieval-clean.json"), JSON.stringify(results, null, 2));

  // Warm latency (semantic query, model loaded).
  const lat: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t0 = Date.now();
    await searchMemory({ query: queries[0].query, repo: REPO, limit: 8 });
    lat.push(Date.now() - t0);
  }
  lat.sort((a, b) => a - b);
  console.log(`\nWARM latency 7 runs (ms): [${lat.join(", ")}] median=${lat[3]}`);
  writeFileSync(path.join(OUT, "latency-clean.json"), JSON.stringify({ warmRunsMs: lat, median: lat[3] }, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

#!/usr/bin/env node
// One-off / periodic near-duplicate cleanup for a project's memory store.
// Runs the SAME dedupeSweep the distiller uses continuously, with a generous
// budget — for draining historical duplicates from a DB that predates top-K
// consolidation. Safe against a live orchestrator: writes are short WAL
// transactions; the server's caches self-heal on its next distill.
//
//   DB_PATH=/path/to/flow.db node --import tsx/esm scripts/dedupe-memories.mjs [--max-pairs N] [--min-sim S] [--dry-run]
//
// ALWAYS take a backup first:  sqlite3 flow.db ".backup flow.db.bak"
// --dry-run lists candidate pairs (cosine + claims) without judging/merging.

import { argv, env, exit } from "node:process";

if (!env.DB_PATH) {
  console.error("DB_PATH is required (path to the project's flow.db)");
  exit(1);
}
env.FLOW_FAKE_OPENCODE = env.FLOW_FAKE_OPENCODE ?? "1"; // no telemetry from ops scripts

const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const maxPairs = flag("--max-pairs", 100);
const minSim = flag("--min-sim", undefined);
const dryRun = argv.includes("--dry-run");

const { candidateDupePairs, dedupeSweep, DEDUPE_SIM } = await import("../orchestrator/src/memory/maintenance.js");
const { haikuJudge } = await import("../orchestrator/src/memory/judge.js");
const db = (await import("../orchestrator/src/db.js")).default;

const before = db.prepare("SELECT count(*) AS n FROM memories WHERE status='active'").get().n;
const pairs = candidateDupePairs(minSim ?? DEDUPE_SIM);
console.log(`[dedupe] ${before} active memories, ${pairs.length} unjudged candidate pairs ≥ ${minSim ?? DEDUPE_SIM}`);

if (dryRun) {
  for (const p of pairs.slice(0, maxPairs)) {
    console.log(`\n  sim=${p.sim.toFixed(3)}`);
    console.log(`  A[${p.a.id.slice(0, 8)}] ${p.a.claim.slice(0, 140)}`);
    console.log(`  B[${p.b.id.slice(0, 8)}] ${p.b.claim.slice(0, 140)}`);
  }
  exit(0);
}

const out = await dedupeSweep(haikuJudge, { maxPairs, ...(minSim !== undefined ? { minSim } : {}) });
const after = db.prepare("SELECT count(*) AS n FROM memories WHERE status='active'").get().n;
console.log(`[dedupe] judged ${out.judged}, merged ${out.merged}, contradicted ${out.contradicted}`);
console.log(`[dedupe] active memories ${before} → ${after}`);

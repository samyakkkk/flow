// maintenance.ts — memory-store upkeep.
//
// sweepMemories: cheap decay sweep, run on distill completion. Recomputes each
// active memory's strength (recency decays it) and sinks any that fall below
// STRENGTH_FLOOR. Pure code, no LLM, no embeddings. Deliberately does NOT
// touch updated_at on surviving rows — bumping it every sweep made every
// memory look minutes old wherever timestamps are displayed.
//
// dedupeSweep: budgeted near-duplicate resolution. Consolidation compares a
// NEW observation against existing memories, so duplicates that slipped in
// historically (or arrived via different sessions judged against different
// neighborhoods) persist forever — production accumulated 4x copies of the
// same decision and direct contradictions living side by side. The sweep
// finds high-cosine ACTIVE memory pairs, asks the same judge that governs
// consolidation, and:
//   same        → merge (move observations to the survivor, sink the dup)
//   refines     → merge, survivor adopts the refined claim
//   contradicts → contradiction_count++ on BOTH (strength penalty resolves it
//                 over time; contested claims are excluded from orient docs)
//   new         → recorded so the pair is never re-judged
// Every verdict is recorded in dedupe_seen keyed by the sorted id pair, so
// sweep cost stays bounded and re-runs converge to zero work.

import db from "../db.js";
import { computeStrength, STRENGTH_FLOOR } from "./strength.js";
import { strongerWeight } from "./strength.js";
import type { MemoryRow } from "./store.js";
import { activeMemoryRows, getMemory, invalidateVectorCache, getEmbedder, observationEmbedText } from "./store.js";
import { recomputeStrength, type Judge } from "./consolidate.js";
import { cosine, blobToVec, vecToBlob } from "../embed.js";
import { invalidateHeadlineCache } from "./headline.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS dedupe_seen (
    a       TEXT NOT NULL,   -- lower memory id of the pair
    b       TEXT NOT NULL,   -- higher memory id of the pair
    verdict TEXT NOT NULL,   -- same | refines | contradicts | new
    at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (a, b)
  )
`);

export function sweepMemories(now = Math.floor(Date.now() / 1000)): { recomputed: number; sunk: number } {
  const rows = db.prepare(`SELECT * FROM memories WHERE status = 'active'`).all() as MemoryRow[];
  // updated_at moves ONLY on the sink transition — a strength recompute is
  // not a content change, and pretending it is destroys timestamp honesty.
  const update = db.prepare(`UPDATE memories SET strength = ? WHERE id = ?`);
  const sink = db.prepare(`UPDATE memories SET strength = ?, status = 'sunk', updated_at = unixepoch() WHERE id = ?`);
  let sunk = 0;
  const tx = db.transaction(() => {
    for (const m of rows) {
      const strength = computeStrength({
        people_count: m.people_count,
        evidence_count: m.evidence_count,
        max_source_weight: m.max_source_weight,
        contradiction_count: m.contradiction_count,
        last_reinforced_at: m.last_reinforced_at ?? m.created_at,
        now,
      });
      if (strength < STRENGTH_FLOOR) {
        sunk++;
        sink.run(strength, m.id);
      } else {
        update.run(strength, m.id);
      }
    }
  });
  tx();
  invalidateVectorCache();
  // Strengths (and thus headline ranking + which memories are active) moved —
  // drop the whole headline cache so get_entity re-renders fresh.
  invalidateHeadlineCache();
  return { recomputed: rows.length, sunk };
}

// ---------------------------------------------------------------------------
// Embedding backfill
//
// Memories/observations embed at WRITE time, best-effort: rows written while
// the embedder was down carry NULL, and rows written under a previous
// embedding model carry vectors of the wrong DIMENSION (observed live: 262 of
// 383 active memories NULL + 121 stale 1536-dim vectors vs the current
// 768-dim space — vector search silently degraded to FTS-only, and the dedupe
// sweep was blind to two thirds of the store). Graph nodes have a reconciler
// for exactly this; memory rows had nothing. This sweep is that reconciler:
// re-embed every row whose vector is missing or dimensionally wrong, in
// budgeted batches, using whatever embedder is currently wired.

export async function reembedSweep(limit = 100): Promise<{ embedded: number; failed: number; remaining: number }> {
  const embedder = getEmbedder();
  // Probe the live dimension once — also proves the embedder is reachable.
  let dim: number;
  try {
    const probe = await embedder("dimension probe");
    if (!probe || probe.length === 0) return { embedded: 0, failed: 0, remaining: -1 };
    dim = probe.length;
  } catch {
    return { embedded: 0, failed: 0, remaining: -1 }; // embedder down; retry next sweep
  }
  const wrong = `(embedding IS NULL OR length(embedding) != ${dim * 4})`;

  let embedded = 0;
  let failed = 0;
  const memRows = db
    .prepare(`SELECT id, claim, retrieval_keys FROM memories WHERE status = 'active' AND ${wrong} LIMIT ?`)
    .all(limit) as Array<{ id: string; claim: string; retrieval_keys: string | null }>;
  for (const r of memRows) {
    try {
      const keys = r.retrieval_keys ? (JSON.parse(r.retrieval_keys) as string[]) : [];
      const vec = await embedder(observationEmbedText(r.claim, keys).slice(0, 2000));
      if (!vec) throw new Error("embedder returned null");
      // updated_at untouched: a vector refresh is not a content change.
      db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(vecToBlob(vec), r.id);
      embedded++;
    } catch {
      failed++;
    }
  }

  const obsRows = db
    .prepare(`SELECT id, claim, retrieval_keys FROM observations WHERE ${wrong} LIMIT ?`)
    .all(Math.max(0, limit - memRows.length)) as Array<{ id: string; claim: string; retrieval_keys: string | null }>;
  for (const r of obsRows) {
    try {
      const keys = r.retrieval_keys ? (JSON.parse(r.retrieval_keys) as string[]) : [];
      const vec = await embedder(observationEmbedText(r.claim, keys).slice(0, 2000));
      if (!vec) throw new Error("embedder returned null");
      db.prepare(`UPDATE observations SET embedding = ? WHERE id = ?`).run(vecToBlob(vec), r.id);
      embedded++;
    } catch {
      failed++;
    }
  }

  if (embedded > 0) invalidateVectorCache();
  const remaining =
    (db.prepare(`SELECT count(*) AS n FROM memories WHERE status = 'active' AND ${wrong}`).get() as { n: number }).n +
    (db.prepare(`SELECT count(*) AS n FROM observations WHERE ${wrong}`).get() as { n: number }).n;
  return { embedded, failed, remaining };
}

let _reembedTimer: ReturnType<typeof setInterval> | null = null;
const REEMBED_INTERVAL_MS = 10 * 60 * 1000;

// Periodic backfill: cheap when there's nothing to do (one probe + two
// indexed counts). FLOW_MEMORY_REEMBED=0 disables.
export function startReembedSweep(): void {
  if (_reembedTimer || process.env.FLOW_MEMORY_REEMBED === "0") return;
  const tick = () =>
    void reembedSweep().then((r) => {
      if (r.embedded > 0 || r.failed > 0) {
        console.log(`[memory] re-embed sweep: ${r.embedded} embedded, ${r.failed} failed, ${r.remaining} remaining`);
      }
    });
  setTimeout(tick, 30 * 1000).unref?.(); // shortly after boot
  _reembedTimer = setInterval(tick, REEMBED_INTERVAL_MS);
  _reembedTimer.unref?.();
}

export function stopReembedSweep(): void {
  if (_reembedTimer) {
    clearInterval(_reembedTimer);
    _reembedTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Near-duplicate resolution

// Cosine floor for considering two ACTIVE memories duplicate candidates.
// Higher than consolidation's T_LO (0.50): pairs here are judged claim-vs-
// claim with no transcript context, so only clearly-close pairs are worth an
// LLM call.
export const DEDUPE_SIM = 0.8;

export interface DedupeOutcome {
  scanned: number; // candidate pairs above the sim floor (before seen-filter)
  judged: number;
  merged: number;
  contradicted: number;
}

interface Pair {
  a: MemoryRow;
  b: MemoryRow;
  sim: number;
}

function pairIds(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

const seenPair = () => db.prepare(`SELECT verdict FROM dedupe_seen WHERE a = ? AND b = ?`);
const recordPair = () =>
  db.prepare(`INSERT OR REPLACE INTO dedupe_seen (a, b, verdict, at) VALUES (?, ?, ?, unixepoch())`);

// All unseen active-memory pairs at/above minSim, best first. O(n²/2) cosines
// in-process — ~400 active memories is ~80k cosines, well under a millisecond
// budget that matters.
export function candidateDupePairs(minSim = DEDUPE_SIM): Pair[] {
  const rows = activeMemoryRows().filter((m) => m.embedding);
  const out: Pair[] = [];
  for (let i = 0; i < rows.length; i++) {
    const vi = blobToVec(rows[i].embedding!);
    for (let j = i + 1; j < rows.length; j++) {
      const sim = cosine(vi, blobToVec(rows[j].embedding!));
      if (sim < minSim) continue;
      const [a, b] = pairIds(rows[i].id, rows[j].id);
      if (seenPair().get(a, b)) continue;
      out.push({ a: rows[i], b: rows[j], sim });
    }
  }
  out.sort((x, y) => y.sim - x.sim);
  return out;
}

// Merge dup into survivor: observations move over, provenance takes the
// stronger weight, reinforcement takes the later timestamp, the dup sinks.
// recomputeStrength then rebuilds evidence/people/keys/strength from the
// now-combined observation set.
export function mergeMemories(survivorId: string, dupId: string, refinedClaim?: string): void {
  const survivor = getMemory(survivorId);
  const dup = getMemory(dupId);
  if (!survivor || !dup) return;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE observations SET memory_id = ? WHERE memory_id = ?`).run(survivorId, dupId);
    db.prepare(
      `UPDATE memories SET max_source_weight = ?, last_reinforced_at = ?, claim = ?, updated_at = unixepoch() WHERE id = ?`,
    ).run(
      strongerWeight(survivor.max_source_weight, dup.max_source_weight),
      Math.max(survivor.last_reinforced_at ?? 0, dup.last_reinforced_at ?? 0) || null,
      refinedClaim?.trim() || survivor.claim,
      survivorId,
    );
    db.prepare(`UPDATE memories SET status = 'sunk', updated_at = unixepoch() WHERE id = ?`).run(dupId);
  });
  tx();
  recomputeStrength(survivorId);
  invalidateVectorCache();
  invalidateHeadlineCache();
}

// The survivor of a same/refines pair: stronger wins; tie → older row (its id
// is the one other systems have referenced longer).
function pickSurvivor(a: MemoryRow, b: MemoryRow): [MemoryRow, MemoryRow] {
  if (a.strength !== b.strength) return a.strength > b.strength ? [a, b] : [b, a];
  return a.created_at <= b.created_at ? [a, b] : [b, a];
}

export async function dedupeSweep(
  judge: Judge,
  opts: { maxPairs?: number; minSim?: number } = {},
): Promise<DedupeOutcome> {
  const maxPairs = opts.maxPairs ?? 20;
  const pairs = candidateDupePairs(opts.minSim ?? DEDUPE_SIM);
  const outcome: DedupeOutcome = { scanned: pairs.length, judged: 0, merged: 0, contradicted: 0 };

  for (const pair of pairs.slice(0, maxPairs)) {
    // Rows may have been merged/sunk by an earlier pair this run.
    const a = getMemory(pair.a.id);
    const b = getMemory(pair.b.id);
    if (!a || !b || a.status !== "active" || b.status !== "active") continue;

    // The judge signature is (existing memory, new observation) — for a
    // memory-vs-memory pair the older row plays "existing"; only .claim is
    // read from the second argument.
    const [older, newer] = a.created_at <= b.created_at ? [a, b] : [b, a];
    let verdict: Awaited<ReturnType<Judge>>;
    try {
      verdict = await judge(older, newer as never);
    } catch {
      continue; // judge transport hiccup: leave the pair unseen, retry next sweep
    }
    outcome.judged++;
    const [pa, pb] = pairIds(a.id, b.id);
    recordPair().run(pa, pb, verdict.verdict);

    if (verdict.verdict === "same" || verdict.verdict === "refines") {
      const [survivor, dup] = pickSurvivor(a, b);
      mergeMemories(survivor.id, dup.id, verdict.verdict === "refines" ? verdict.refinedClaim : undefined);
      outcome.merged++;
    } else if (verdict.verdict === "contradicts") {
      // Both claims stay, both marked contested: strength decays them and
      // orient-doc membership excludes them until evidence resolves it.
      for (const m of [a, b]) {
        db.prepare(`UPDATE memories SET contradiction_count = contradiction_count + 1 WHERE id = ?`).run(m.id);
        recomputeStrength(m.id);
      }
      outcome.contradicted++;
    }
  }
  if (outcome.merged > 0) {
    invalidateVectorCache();
    invalidateHeadlineCache();
  }
  return outcome;
}

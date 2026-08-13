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
import { activeMemoryRows, getMemory, invalidateVectorCache } from "./store.js";
import { recomputeStrength, type Judge } from "./consolidate.js";
import { cosine, blobToVec } from "../embed.js";
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

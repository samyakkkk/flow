// maintenance.ts — cheap decay sweep, run on distill completion. Recomputes
// each active memory's strength (recency decays it) and sinks any that fall
// below STRENGTH_FLOOR to status 'sunk'. Pure code, no LLM, no embeddings.

import db from "../db.js";
import { computeStrength, STRENGTH_FLOOR } from "./strength.js";
import type { MemoryRow } from "./store.js";
import { invalidateVectorCache } from "./store.js";
import { invalidateHeadlineCache } from "./headline.js";

export function sweepMemories(now = Math.floor(Date.now() / 1000)): { recomputed: number; sunk: number } {
  const rows = db.prepare(`SELECT * FROM memories WHERE status = 'active'`).all() as MemoryRow[];
  const update = db.prepare(`UPDATE memories SET strength = ?, status = ?, updated_at = unixepoch() WHERE id = ?`);
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
      const status = strength < STRENGTH_FLOOR ? "sunk" : "active";
      if (status === "sunk") sunk++;
      update.run(strength, status, m.id);
    }
  });
  tx();
  invalidateVectorCache();
  // Strengths (and thus headline ranking + which memories are active) moved —
  // drop the whole headline cache so get_entity re-renders fresh.
  invalidateHeadlineCache();
  return { recomputed: rows.length, sunk };
}

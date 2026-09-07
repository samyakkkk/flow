// knowledge.ts — the Knowledge Base surface (dashboard). Reads the whole
// memory store with human attribution (who said it, where it came from) and
// deletes — the one curation act. Deletion is a hard cascade: a memory takes
// its attached observations and anchors with it (the FTS mirror follows via
// the observations_ad trigger), so the claim stops surfacing everywhere at
// once — search_knowledge, find_entity hits, headlines and orient docs alike.

import db from "../db.js";
import { strengthTier } from "./strength.js";
import {
  evidenceCount,
  getMemory,
  invalidateVectorCache,
  recomputePeopleCount,
  updateMemory,
  type MemoryRow,
} from "./store.js";
import { invalidateHeadlineCache } from "./headline.js";
import { rebuildOrientDocsFor } from "./orient-doc.js";
import { sweepMemories } from "./maintenance.js";

// The dashboard loads memories in one shot (a few hundred rows) and pages the
// corpus (slack/linear/meeting observations can run to thousands).
const MEMORY_CAP = 500;
const CORPUS_PAGE_MAX = 200;
const EVIDENCE_PER_MEMORY = 20;

interface JoinedObsRow {
  id: string;
  source: string;
  repo: string | null;
  branch: string | null;
  session_id: string | null;
  source_url: string | null;
  claim: string;
  kind: string;
  source_weight: string;
  memory_id: string | null;
  created_at: number;
  session_title: string | null;
  session_backend: string | null;
  slack_user: string | null;
  slack_channel: string | null;
  linear_identifier: string | null;
  linear_assignee: string | null;
  meeting_speaker: string | null;
}

// One join buys attribution for every source: sessions by session_id, corpus
// rows by source_id (slack corpus ids ARE the observations' source_id — same
// originating event id; linear/meeting likewise).
const OBS_JOIN = `
  SELECT o.id, o.source, o.repo, o.branch, o.session_id, o.source_url, o.claim,
         o.kind, o.source_weight, o.memory_id, o.created_at,
         s.title AS session_title, s.backend AS session_backend,
         sm.user_id AS slack_user, sm.channel AS slack_channel,
         lt.identifier AS linear_identifier, lt.assignee AS linear_assignee,
         ms.speaker AS meeting_speaker
  FROM observations o
  LEFT JOIN agent_sessions s    ON o.source = 'session' AND s.id = o.session_id
  LEFT JOIN slack_messages sm   ON o.source = 'slack'   AND sm.id = o.source_id
  LEFT JOIN linear_tickets lt   ON o.source = 'linear'  AND lt.id = o.source_id
  LEFT JOIN meeting_segments ms ON o.source = 'meeting' AND ms.id = o.source_id
`;

// Human attribution line for one observation — who, where. Session capture
// carries no user identity yet (it's per-machine), so the engine + session
// title stand in for the person; Slack/Linear/meetings carry real identities.
function attribution(o: JoinedObsRow): string | null {
  switch (o.source) {
    case "session": {
      const engine = (o.session_backend ?? "").replace(/^ext:/, "");
      const title = (o.session_title ?? "").trim();
      if (engine && title) return `${engine} session — ${title}`;
      if (engine) return `${engine} session`;
      return o.session_id ? `session ${o.session_id.slice(0, 12)}` : null;
    }
    case "slack": {
      const user = o.slack_user ? `@${o.slack_user}` : "Slack";
      return o.slack_channel ? `${user} in #${o.slack_channel}` : user;
    }
    case "linear": {
      if (!o.linear_identifier) return "Linear";
      return o.linear_assignee ? `${o.linear_identifier} — ${o.linear_assignee}` : o.linear_identifier;
    }
    case "meeting":
      return o.meeting_speaker ? `${o.meeting_speaker} (meeting)` : "meeting";
    default:
      return null;
  }
}

export interface KnowledgeEvidence {
  id: string;
  source: string;
  claim: string;
  source_url: string | null;
  source_weight: string;
  created_at: number;
  by: string | null;
}

export interface KnowledgeMemory {
  id: string;
  claim: string;
  kind: string;
  repo: string | null;
  strength: number;
  tier: string;
  evidence_count: number;
  people_count: number;
  contradiction_count: number;
  max_source_weight: string;
  created_at: number;
  updated_at: number;
  last_reinforced_at: number | null;
  contributors: string[];
  sources: Record<string, number>;
  evidence: KnowledgeEvidence[];
}

export interface KnowledgeCorpusRow {
  id: string;
  source: string;
  claim: string;
  source_url: string | null;
  repo: string | null;
  created_at: number;
  by: string | null;
}

export interface KnowledgeList {
  memories: KnowledgeMemory[];
  memory_cap: number;
  corpus: { rows: KnowledgeCorpusRow[]; total: number; limit: number; offset: number };
}

export function listKnowledge(opts: {
  q?: string | null;
  source?: string | null;
  limit?: number;
  offset?: number;
} = {}): KnowledgeList {
  // NOT updated_at: the decay sweep rewrites updated_at on every active row
  // (sweepMemories runs after each distill), so it always reads "minutes ago".
  // Reinforcement time is the honest freshness signal.
  const memories = db
    .prepare(`SELECT * FROM memories WHERE status = 'active' ORDER BY COALESCE(last_reinforced_at, created_at) DESC LIMIT ?`)
    .all(MEMORY_CAP) as MemoryRow[];

  const attached = db
    .prepare(`${OBS_JOIN} WHERE o.memory_id IS NOT NULL ORDER BY o.created_at DESC`)
    .all() as JoinedObsRow[];
  const byMemory = new Map<string, JoinedObsRow[]>();
  for (const o of attached) {
    const list = byMemory.get(o.memory_id!) ?? [];
    list.push(o);
    byMemory.set(o.memory_id!, list);
  }

  const memoryItems: KnowledgeMemory[] = memories.map((m) => {
    const obs = byMemory.get(m.id) ?? [];
    const contributors = [...new Set(obs.map(attribution).filter((s): s is string => !!s))];
    const sources: Record<string, number> = {};
    for (const o of obs) sources[o.source] = (sources[o.source] ?? 0) + 1;
    return {
      id: m.id,
      claim: m.claim,
      kind: m.kind,
      repo: m.repo,
      strength: Math.round(m.strength * 1000) / 1000,
      tier: strengthTier(m.strength),
      evidence_count: m.evidence_count,
      people_count: m.people_count,
      contradiction_count: m.contradiction_count,
      max_source_weight: m.max_source_weight,
      created_at: m.created_at,
      updated_at: m.updated_at,
      last_reinforced_at: m.last_reinforced_at,
      contributors: contributors.slice(0, 6),
      sources,
      evidence: obs.slice(0, EVIDENCE_PER_MEMORY).map((o) => ({
        id: o.id,
        source: o.source,
        claim: o.claim,
        source_url: o.source_url,
        source_weight: o.source_weight,
        created_at: o.created_at,
        by: attribution(o),
      })),
    };
  });

  // Corpus = observations never consolidated into a memory (slack/linear/
  // meeting enrichment rows). Paged, filterable by source and substring.
  const where: string[] = ["o.memory_id IS NULL"];
  const params: unknown[] = [];
  if (opts.source) {
    where.push("o.source = ?");
    params.push(opts.source);
  }
  if (opts.q && opts.q.trim()) {
    where.push("o.claim LIKE ?");
    params.push(`%${opts.q.trim()}%`);
  }
  const whereSql = where.join(" AND ");
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM observations o WHERE ${whereSql}`).get(...params) as { n: number }
  ).n;
  const limit = Math.min(Math.max(1, opts.limit ?? 50), CORPUS_PAGE_MAX);
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = db
    .prepare(`${OBS_JOIN} WHERE ${whereSql} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as JoinedObsRow[];

  return {
    memories: memoryItems,
    memory_cap: MEMORY_CAP,
    corpus: {
      rows: rows.map((o) => ({
        id: o.id,
        source: o.source,
        claim: o.claim,
        source_url: o.source_url,
        repo: o.repo,
        created_at: o.created_at,
        by: attribution(o),
      })),
      total,
      limit,
      offset,
    },
  };
}

// ---------------------------------------------------------------------------
// Deletion — the one human curation act. Hard delete, full cascade.

const deleteAnchorsStmt = () => db.prepare(`DELETE FROM anchors WHERE item_type = ? AND item_id = ?`);

export function deleteMemory(id: string): { observations: number } | null {
  const mem = getMemory(id);
  if (!mem) return null;
  const obs = db.prepare(`SELECT id FROM observations WHERE memory_id = ?`).all(id) as Array<{ id: string }>;
  const tx = db.transaction(() => {
    deleteAnchorsStmt().run("memory", id);
    for (const o of obs) deleteAnchorsStmt().run("observation", o.id);
    db.prepare(`DELETE FROM observations WHERE memory_id = ?`).run(id);
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  });
  tx();
  invalidateVectorCache();
  invalidateHeadlineCache();
  rebuildOrientDocsFor(mem.repo);
  return { observations: obs.length };
}

// Deleting a lone corpus observation just removes it. Deleting a memory's
// evidence recomputes the parent's counts and strength; a memory whose last
// evidence is gone is deleted outright (a claim with zero provenance is not
// knowledge).
export function deleteObservation(id: string): { memory_deleted: boolean } | null {
  const row = db.prepare(`SELECT id, repo, memory_id FROM observations WHERE id = ?`).get(id) as
    | { id: string; repo: string | null; memory_id: string | null }
    | undefined;
  if (!row) return null;

  const tx = db.transaction(() => {
    deleteAnchorsStmt().run("observation", id);
    db.prepare(`DELETE FROM observations WHERE id = ?`).run(id);
  });
  tx();

  let memoryDeleted = false;
  if (row.memory_id) {
    const remaining = evidenceCount(row.memory_id);
    if (remaining === 0) {
      deleteAnchorsStmt().run("memory", row.memory_id);
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(row.memory_id);
      memoryDeleted = true;
    } else {
      updateMemory(row.memory_id, {
        evidence_count: remaining,
        people_count: recomputePeopleCount(row.memory_id),
      });
      sweepMemories();
    }
  }
  invalidateVectorCache();
  invalidateHeadlineCache();
  rebuildOrientDocsFor(row.repo);
  return { memory_deleted: memoryDeleted };
}

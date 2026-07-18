// cards.ts — drill-down cards (Section C). Each new id namespace resolves to a
// structured card the gateway serves via get_entity (single or batch ids[]):
//
//   mem:<uuid>          → claim, kind, strength value+tier + breakdown
//                         (people_count, evidence_count, max source_weight,
//                          contradiction_count, last_reinforced), born
//                         (repo/branch/date), context files, anchors as node
//                         ids, evidence observations as one-liners [obs:<id>].
//   obs:<uuid>          → full text, source, session/channel, date, parent
//                         memory id.
//   lin:<identifier>    → title/status/description(truncated)/latest stored
//                         comments + permalink + anchored nodes.
//   slackthread:<ts>    → root text, participants, stored messages one-liners,
//                         permalink.
//
// IMPLEMENTATION CHOICE (documented): the gateway resolves these namespaces by
// calling the orchestrator over HTTP (/v1/memory/card/:type/:id) — the same
// proxy pattern as FLOW_NOTES_URL / search_knowledge. The orchestrator owns
// flow.db (memories, observations, corpus, anchors), so reading here is a
// single indexed lookup with no graph round-trip. Cards carry NODE IDS for
// anchors (not node bodies) so the model can get_entity them next.

import db from "../db.js";
import { strengthTier } from "./strength.js";
import { nodeIdsForItem } from "./anchors.js";

const DESC_TRUNC = 400;
const LINE_TRUNC = 140;

export type CardType = "mem" | "obs" | "lin" | "slackthread";

export interface CardResult {
  status: "found" | "not_found";
  type: CardType;
  id: string;
  card?: Record<string, unknown>;
}

function trunc(s: string | null | undefined, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function parseKeys(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function isoDate(epochSec: number | null | undefined): string | null {
  if (!epochSec) return null;
  return new Date(epochSec * 1000).toISOString();
}

// ---- mem:<uuid> ----
function memoryCard(id: string): CardResult {
  const m = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as
    | {
        id: string;
        claim: string;
        kind: string;
        repo: string | null;
        repo_family: string | null;
        strength: number;
        evidence_count: number;
        people_count: number;
        contradiction_count: number;
        last_reinforced_at: number | null;
        max_source_weight: string;
        retrieval_keys: string | null;
        created_at: number;
        status: string;
      }
    | undefined;
  if (!m) return { status: "not_found", type: "mem", id };

  // Evidence observations attached to this memory — one-liners with [obs:id].
  // url is the citation back to the original artifact (slack permalink, linear
  // ticket) when the observation carries one.
  const obsRows = db
    .prepare(
      `SELECT id, source, claim, branch, context_files, source_url FROM observations
       WHERE memory_id = ? ORDER BY created_at DESC LIMIT 12`,
    )
    .all(id) as Array<{ id: string; source: string; claim: string; branch: string | null; context_files: string | null; source_url: string | null }>;
  const evidence = obsRows.map((o) => ({
    id: `obs:${o.id}`,
    line: `[${o.source}] ${trunc(o.claim, LINE_TRUNC)}`,
    ...(o.source_url ? { url: o.source_url } : {}),
  }));

  // Context files = union across attached observations.
  const ctxFiles = new Set<string>();
  for (const o of obsRows) for (const f of parseKeys(o.context_files)) ctxFiles.add(f);

  // "Born" = the earliest observation's repo/branch/date.
  const born = db
    .prepare(`SELECT repo, branch, created_at FROM observations WHERE memory_id = ? ORDER BY created_at ASC LIMIT 1`)
    .get(id) as { repo: string | null; branch: string | null; created_at: number } | undefined;

  return {
    status: "found",
    type: "mem",
    id,
    card: {
      kind: "memory",
      claim: m.claim,
      memory_kind: m.kind,
      strength: { value: Math.round(m.strength * 1000) / 1000, tier: strengthTier(m.strength) },
      breakdown: {
        people_count: m.people_count,
        evidence_count: m.evidence_count,
        max_source_weight: m.max_source_weight,
        contradiction_count: m.contradiction_count,
        last_reinforced: isoDate(m.last_reinforced_at),
      },
      born: born ? { repo: born.repo, branch: born.branch, date: isoDate(born.created_at) } : null,
      context_files: [...ctxFiles],
      anchors: nodeIdsForItem("memory", id), // node ids the model can get_entity
      evidence,
    },
  };
}

// ---- obs:<uuid> ----
function observationCard(id: string): CardResult {
  const o = db.prepare(`SELECT * FROM observations WHERE id = ?`).get(id) as
    | {
        id: string;
        source: string;
        repo: string | null;
        branch: string | null;
        session_id: string | null;
        source_url: string | null;
        claim: string;
        kind: string;
        source_weight: string;
        context_files: string | null;
        retrieval_keys: string | null;
        memory_id: string | null;
        created_at: number;
      }
    | undefined;
  if (!o) return { status: "not_found", type: "obs", id };
  return {
    status: "found",
    type: "obs",
    id,
    card: {
      kind: "observation",
      text: o.claim,
      source: o.source,
      source_url: o.source_url, // citation back to the original artifact
      observation_kind: o.kind,
      source_weight: o.source_weight,
      session: o.session_id,
      channel: null, // corpus channel is carried on the corpus row; obs is repo-scoped
      repo: o.repo,
      branch: o.branch,
      date: isoDate(o.created_at),
      context_files: parseKeys(o.context_files),
      parent_memory: o.memory_id ? `mem:${o.memory_id}` : null,
      anchors: nodeIdsForItem("observation", id),
    },
  };
}

// ---- lin:<identifier> ----
function linearCard(identifier: string): CardResult {
  const t = db.prepare(`SELECT * FROM linear_tickets WHERE identifier = ? LIMIT 1`).get(identifier) as
    | {
        id: string;
        identifier: string;
        title: string;
        description: string | null;
        state: string | null;
        assignee: string | null;
        url: string | null;
        updated_at: number | null;
      }
    | undefined;
  if (!t) return { status: "not_found", type: "lin", id: identifier };

  // Anchored nodes: any observation derived from this ticket that got anchored.
  // t.id is the observation's source_id (exact FK); identifier covers rows
  // written before source refs existed.
  const anchoredNodes = anchoredNodesForCorpus("linear", identifier, [t.id]);

  return {
    status: "found",
    type: "lin",
    id: identifier,
    card: {
      kind: "ticket",
      identifier: t.identifier,
      title: t.title,
      status: t.state,
      description: trunc(t.description, DESC_TRUNC),
      assignee: t.assignee,
      permalink: t.url,
      updated_at: isoDate(t.updated_at),
      anchored_nodes: anchoredNodes,
    },
  };
}

// ---- slackthread:<ts> ----
function slackThreadCard(ts: string): CardResult {
  // Root message is the one whose ts equals the thread ts (or a message with
  // that thread_ts if the root wasn't captured). Reply messages share thread_ts.
  const root =
    (db.prepare(`SELECT * FROM slack_messages WHERE ts = ? LIMIT 1`).get(ts) as SlackRow | undefined) ??
    (db.prepare(`SELECT * FROM slack_messages WHERE thread_ts = ? ORDER BY ts ASC LIMIT 1`).get(ts) as SlackRow | undefined);
  if (!root) return { status: "not_found", type: "slackthread", id: ts };

  const rootTs = root.thread_ts || root.ts;
  const messages = db
    .prepare(
      `SELECT id, user_id, text, ts, permalink FROM slack_messages
       WHERE ts = ? OR thread_ts = ? ORDER BY ts ASC LIMIT 30`,
    )
    .all(rootTs, rootTs) as Array<{ id: string; user_id: string | null; text: string; ts: string; permalink: string | null }>;
  const participants = [...new Set(messages.map((m) => m.user_id).filter((u): u is string => !!u))];

  return {
    status: "found",
    type: "slackthread",
    id: ts,
    card: {
      kind: "thread",
      root_text: root.text,
      channel: root.channel,
      participants,
      permalink: root.permalink,
      messages: messages.map((m) => ({
        user: m.user_id,
        line: trunc(m.text, LINE_TRUNC),
        ts: m.ts,
      })),
      // Slack corpus row ids ARE the observations' source_id (both are the
      // originating event id), so the thread's messages give the exact keys.
      anchored_nodes: anchoredNodesForCorpus("slack", rootTs, messages.map((m) => m.id)),
    },
  };
}

interface SlackRow {
  id: string;
  channel: string | null;
  user_id: string | null;
  text: string;
  ts: string;
  thread_ts: string | null;
  permalink: string | null;
}

// Nodes anchored via a corpus observation matching this source + key. Since
// migration 10 corpus observations carry source_id (exact FK to the corpus
// row); sourceId matches those directly. Rows written before that fall back to
// the identifier/ts appearing in retrieval_keys or the claim. Best-effort.
function anchoredNodesForCorpus(source: string, key: string, sourceIds: string[] = []): string[] {
  const nodeIds = new Set<string>();
  if (sourceIds.length) {
    const ph = sourceIds.map(() => "?").join(",");
    const exact = db
      .prepare(`SELECT id FROM observations WHERE source = ? AND source_id IN (${ph})`)
      .all(source, ...sourceIds) as Array<{ id: string }>;
    for (const r of exact) for (const n of nodeIdsForItem("observation", r.id)) nodeIds.add(n);
  }
  const rows = db
    .prepare(`SELECT id, retrieval_keys, claim FROM observations WHERE source = ? AND source_id IS NULL`)
    .all(source) as Array<{ id: string; retrieval_keys: string | null; claim: string }>;
  for (const r of rows) {
    const keys = parseKeys(r.retrieval_keys);
    const hit = keys.some((k) => k === key || k === `ts:${key}`) || r.claim.includes(key);
    if (!hit) continue;
    for (const n of nodeIdsForItem("observation", r.id)) nodeIds.add(n);
  }
  return [...nodeIds];
}

// ---------------------------------------------------------------------------
// Dispatch — the gateway calls getCard(type, id). Unknown type → not_found.

export function getCard(type: string, id: string): CardResult {
  switch (type) {
    case "mem":
      return memoryCard(id);
    case "obs":
      return observationCard(id);
    case "lin":
      return linearCard(id);
    case "slackthread":
      return slackThreadCard(id);
    default:
      return { status: "not_found", type: type as CardType, id };
  }
}

// Parse a namespaced id token ("mem:<uuid>") into {type, id}, or null if it's
// not a card namespace. Shared with the gateway's get_entity dispatch shape.
const CARD_TYPES = new Set(["mem", "obs", "lin", "slackthread"]);
export function parseCardId(raw: string): { type: CardType; id: string } | null {
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const type = raw.slice(0, i);
  if (!CARD_TYPES.has(type)) return null;
  const id = raw.slice(i + 1);
  if (!id) return null;
  return { type: type as CardType, id };
}

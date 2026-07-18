// headline.ts — the node headline index (Section B). Given a graph node id,
// return the memories / tickets / threads anchored to it as TYPED, terse
// headline sections. NO bodies — headlines only. HARD token cap (~300 tokens ≈
// 1200 chars) across all sections combined; overflow becomes a "+N more" line
// that is itself a working node-scoped search query.
//
// Rendering rules (final):
//   - Three typed sections, NEVER blended: MEMORIES, TICKETS, THREADS.
//   - MEMORIES: strength-ranked; tier glyph; one line; claim truncated ~110ch;
//               id token [mem:<id>].
//   - TICKETS: recency + status; [lin:<identifier>].
//   - THREADS: recency; permalink; [slackthread:<ts>].
//   - Total capped ~1200 chars; when a section overflows, append
//     "+N more: search_memory node:<node_id> type:<t>".
//
// Served FAST: an in-process cache keyed by node id, invalidated on
// consolidation (see consolidate.ts). Must add <20ms to get_entity — the query
// is index-backed and the render is pure string work.

import db from "../db.js";
import { strengthTier } from "./strength.js";
import { itemsAnchoredToNode } from "./anchors.js";

// ~300 tokens ≈ 1200 chars. Kept as a single budget across sections so the node
// can gain memories/tickets/threads without the headline growing unbounded.
export const HEADLINE_CHAR_CAP = 1200;
const CLAIM_TRUNC = 110;
// Per-section fetch ceiling — we never need more rows than could fit the budget.
const SECTION_FETCH = 25;

const TIER_GLYPH: Record<string, string> = { strong: "●", medium: "◐", weak: "○" };

export interface HeadlineMemory {
  id: string;
  claim: string;
  kind: string;
  strength: number;
  tier: string;
}
export interface HeadlineTicket {
  identifier: string;
  title: string;
  state: string | null;
  updated_at: number | null;
}
export interface HeadlineThread {
  ts: string;
  text: string;
  permalink: string | null;
  inserted_at: number;
}

export interface NodeHeadline {
  node_id: string;
  memories: HeadlineMemory[];
  tickets: HeadlineTicket[];
  threads: HeadlineThread[];
}

function trunc(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Pull the raw attachments for a node from flow.db. Memories are strength-ranked;
// tickets/threads by recency. Corpus rows are reached via observations anchored
// to the node (item_type 'observation'), joined to their source table.
export function nodeHeadline(nodeId: string): NodeHeadline {
  const anchors = itemsAnchoredToNode(nodeId);
  const memoryIds = anchors.filter((a) => a.item_type === "memory").map((a) => a.item_id);
  const observationIds = anchors.filter((a) => a.item_type === "observation").map((a) => a.item_id);

  const memories: HeadlineMemory[] = [];
  if (memoryIds.length) {
    const ph = memoryIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, claim, kind, strength FROM memories
         WHERE status = 'active' AND id IN (${ph})
         ORDER BY strength DESC LIMIT ${SECTION_FETCH}`,
      )
      .all(...memoryIds) as Array<{ id: string; claim: string; kind: string; strength: number }>;
    for (const r of rows) {
      memories.push({ id: r.id, claim: r.claim, kind: r.kind, strength: r.strength, tier: strengthTier(r.strength) });
    }
  }

  // Corpus attachments: an anchored observation carries source + source id. We
  // join back to linear_tickets / slack_messages by matching the observation's
  // claim text is unreliable — instead corpus observations store no FK, so we
  // surface tickets/threads whose text the observation was derived from via the
  // corpus tables directly keyed by the observation's source + repo. To keep
  // this deterministic and offline, we read the observation's source and, when
  // it's linear/slack, look up the most recent matching corpus rows in the same
  // repo family. (A future indexer can store an explicit FK; this is the
  // pragmatic v1.)
  const tickets: HeadlineTicket[] = [];
  const threads: HeadlineThread[] = [];
  if (observationIds.length) {
    const ph = observationIds.map(() => "?").join(",");
    const obs = db
      .prepare(`SELECT id, source, claim, retrieval_keys FROM observations WHERE id IN (${ph})`)
      .all(...observationIds) as Array<{ id: string; source: string; claim: string; retrieval_keys: string | null }>;
    for (const o of obs) {
      if (o.source === "linear") {
        // Linear identifier is carried in retrieval_keys or is the leading token.
        const ident = extractLinearIdentifier(o.retrieval_keys, o.claim);
        if (ident) {
          const t = db
            .prepare(`SELECT identifier, title, state, updated_at FROM linear_tickets WHERE identifier = ? LIMIT 1`)
            .get(ident) as HeadlineTicket | undefined;
          if (t && t.identifier) tickets.push(t);
        }
      } else if (o.source === "slack") {
        const ts = extractSlackTs(o.retrieval_keys);
        if (ts) {
          const m = db
            .prepare(`SELECT ts, text, permalink, inserted_at FROM slack_messages WHERE ts = ? LIMIT 1`)
            .get(ts) as HeadlineThread | undefined;
          if (m && m.ts) threads.push(m);
        }
      }
    }
  }
  tickets.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  threads.sort((a, b) => (b.inserted_at ?? 0) - (a.inserted_at ?? 0));
  return { node_id: nodeId, memories, tickets, threads };
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

// Linear identifiers look like ACME-123.
export function extractLinearIdentifier(retrievalKeys: string | null, claim: string): string | null {
  for (const k of parseKeys(retrievalKeys)) {
    const m = k.match(/^[A-Z][A-Z0-9]+-\d+$/);
    if (m) return m[0];
  }
  const m = claim.match(/\b[A-Z][A-Z0-9]+-\d+\b/);
  return m ? m[0] : null;
}

// Slack ts keys are stored as "ts:1712345678.001" or a bare "1712.." float.
export function extractSlackTs(retrievalKeys: string | null): string | null {
  for (const k of parseKeys(retrievalKeys)) {
    const m = k.match(/^(?:ts:)?(\d{6,}\.\d+)$/);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Render — typed sections, hard char cap, "+N more" overflow lines.

export function renderNodeHeadline(h: NodeHeadline): string {
  const lines: string[] = [];
  let budget = HEADLINE_CHAR_CAP;

  const moreLine = (remaining: number, type: string): string =>
    `  +${remaining} more: search_memory node:${h.node_id} type:${type}`;

  // Render one typed section. RESERVES room for a "+N more" line before the last
  // item that would fit, so the overflow line ALWAYS fits within the cap (a
  // silently-dropped +N more would be a dead end). Header + blank separator are
  // charged to the shared budget. Returns nothing; mutates `lines`/`budget`.
  const renderSection = <T>(header: string, items: T[], type: string, line: (item: T) => string): void => {
    if (items.length === 0) return;
    const sep = lines.length ? 1 : 0; // blank line before a non-first section
    const headerCost = sep + header.length + 1;
    if (headerCost > budget) return;
    if (sep) lines.push("");
    lines.push(header);
    budget -= headerCost;

    let shown = 0;
    for (let i = 0; i < items.length; i++) {
      const text = line(items[i]);
      const cost = text.length + 1;
      const remainingAfter = items.length - (i + 1);
      // If more items remain, reserve room for the overflow line we'd need next.
      const reserve = remainingAfter > 0 ? moreLine(remainingAfter, type).length + 1 : 0;
      if (cost + reserve > budget) break;
      lines.push(text);
      budget -= cost;
      shown++;
    }
    if (shown < items.length) {
      const ml = moreLine(items.length - shown, type);
      if (ml.length + 1 <= budget) {
        lines.push(ml);
        budget -= ml.length + 1;
      }
    }
  };

  renderSection("MEMORIES:", h.memories, "memory", (m) => {
    const glyph = TIER_GLYPH[m.tier] ?? "○";
    return `  ${glyph} ${trunc(m.claim, CLAIM_TRUNC)} [${m.kind}] [mem:${m.id}]`;
  });
  renderSection("TICKETS:", h.tickets, "ticket", (t) => {
    const status = t.state ? ` (${t.state})` : "";
    return `  ${trunc(t.title, CLAIM_TRUNC)}${status} [lin:${t.identifier}]`;
  });
  renderSection("THREADS:", h.threads, "thread", (th) => {
    const link = th.permalink ? ` ${th.permalink}` : "";
    return `  ${trunc(th.text, CLAIM_TRUNC)}${link} [slackthread:${th.ts}]`;
  });

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// In-process cache — keyed by node id, invalidated on consolidation. The
// rendered string is cached (that's what get_entity ships) so a repeat fetch is
// a Map hit. Empty headline (no attachments) is cached too — an unanchored node
// shouldn't re-query flow.db every get_entity.

const _cache = new Map<string, { rendered: string; headline: NodeHeadline }>();

export function invalidateHeadlineCache(nodeId?: string): void {
  if (nodeId === undefined) _cache.clear();
  else _cache.delete(nodeId);
}

export interface HeadlineResult {
  node_id: string;
  rendered: string;
  hasAttachments: boolean;
  counts: { memories: number; tickets: number; threads: number };
}

export function getNodeHeadline(nodeId: string): HeadlineResult {
  let entry = _cache.get(nodeId);
  if (!entry) {
    const headline = nodeHeadline(nodeId);
    entry = { rendered: renderNodeHeadline(headline), headline };
    _cache.set(nodeId, entry);
  }
  const h = entry.headline;
  const hasAttachments = h.memories.length + h.tickets.length + h.threads.length > 0;
  return {
    node_id: nodeId,
    rendered: entry.rendered,
    hasAttachments,
    counts: { memories: h.memories.length, tickets: h.tickets.length, threads: h.threads.length },
  };
}

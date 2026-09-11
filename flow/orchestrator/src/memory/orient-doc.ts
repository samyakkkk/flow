// orient-doc.ts — the AMBIENT memory tier: one curated document per scope,
// returned verbatim and in full by orient(). This is the auto-authored
// AGENTS.md — nothing here is hand-written or synced to agent machines.
//
// The doc is a DERIVED VIEW over memories (memories stay primary, the doc is
// rebuildable at any time):
//
//   membership(scope) = active memories in scope
//     WHERE kind != 'plan'                     -- plans go stale; they decay as memories
//       AND ambient-nominated                  -- some attached observation said "every
//                                              -- session here should see this"
//       AND contradiction_count = 0            -- contested claims are never doctrine
//       AND (user_stated OR evidence >= 2)     -- the human dictated it, or the claim
//                                              -- EARNED corroboration across sessions
//                                              -- (a fresh single agent claim already
//                                              -- clears the 'strong' strength tier, so
//                                              -- tier is NOT the bar — repetition is)
//
// Scope 'repo:<name>' matches memories with that repo; 'global' matches
// repo-less memories (project-wide facts with no single home). Exit is
// automatic: a memory that sinks (decay), picks up a contradiction, or loses
// its corroboration simply stops matching on the next rebuild — connect and
// disconnect, no doc-editing machinery.
//
// Render v1 is DETERMINISTIC (no LLM in the write path): claims are already
// crisp 1-2 sentence statements, so the doc is claims grouped into sections by
// kind, each line carrying its [mem:id] for drill-down. An LLM prose-polish
// pass can replace renderOrientDoc later without touching membership.

import db from "../db.js";
import type { MemoryRow } from "./store.js";

// Section order + headings, keyed by memory kind. 'plan' is deliberately absent.
const SECTIONS: Array<[kind: string, heading: string]> = [
  ["preference", "Working preferences"],
  ["decision", "Decisions"],
  ["constraint", "Constraints"],
  ["gotcha", "Gotchas"],
  ["how_to", "How-to"],
];

export function orientScopeForRepo(repo: string): string {
  return `repo:${repo}`;
}

// The current member set for a scope, recomputed from primary data. Ordered:
// user_stated before earned-in, then by strength — the doc reads
// human-dictated principles first.
export function orientMembers(scope: string): MemoryRow[] {
  const repoClause = scope === "global" ? "m.repo IS NULL" : "m.repo = ?";
  const params: string[] = scope === "global" ? [] : [scope.replace(/^repo:/, "")];
  return db
    .prepare(
      `SELECT m.* FROM memories m
       WHERE m.status = 'active' AND m.kind != 'plan' AND ${repoClause}
         AND m.contradiction_count = 0
         AND EXISTS (SELECT 1 FROM observations o WHERE o.memory_id = m.id AND o.ambient = 1)
         AND (m.max_source_weight = 'user_stated' OR m.evidence_count >= 2)
       ORDER BY (m.max_source_weight = 'user_stated') DESC, m.strength DESC`,
    )
    .all(...params) as MemoryRow[];
}

// Deterministic render: sections by kind, one claim per line with its [mem:id].
// Returns "" when there are no members (no doc row is kept for empty scopes).
export function renderOrientDoc(scope: string, members: MemoryRow[]): string {
  if (members.length === 0) return "";
  const title =
    scope === "global"
      ? "HOW THIS PROJECT WORKS (distilled from sessions — drill any [mem:id] with get_entity):"
      : `HOW THIS REPO WORKS (distilled from sessions — drill any [mem:id] with get_entity):`;
  const out: string[] = [title];
  for (const [kind, heading] of SECTIONS) {
    const section = members.filter((m) => m.kind === kind);
    if (section.length === 0) continue;
    out.push(`${heading}:`);
    for (const m of section) out.push(`- ${m.claim} [mem:${m.id}]`);
  }
  return out.join("\n");
}

// Recompute membership + render for one scope; persist only when something
// changed (member set or any member's claim text). Returns whether it did.
export function rebuildOrientDoc(scope: string): boolean {
  const members = orientMembers(scope);
  const content = renderOrientDoc(scope, members);
  const memberIds = JSON.stringify(members.map((m) => m.id));
  const existing = db.prepare(`SELECT content, member_ids, revision FROM orient_docs WHERE scope = ?`).get(scope) as
    | { content: string; member_ids: string; revision: number }
    | undefined;

  if (content === "") {
    if (!existing) return false;
    db.prepare(`DELETE FROM orient_docs WHERE scope = ?`).run(scope);
    return true;
  }
  if (existing && existing.content === content && existing.member_ids === memberIds) return false;
  db.prepare(
    `INSERT INTO orient_docs (scope, content, member_ids, revision, updated_at)
     VALUES (@scope, @content, @member_ids, 1, unixepoch())
     ON CONFLICT(scope) DO UPDATE SET
       content = excluded.content, member_ids = excluded.member_ids,
       revision = orient_docs.revision + 1, updated_at = unixepoch()`,
  ).run({ scope, content, member_ids: memberIds });
  return true;
}

// Post-distillation hook: rebuild the scopes a session's observations can have
// touched (its repo + global). Non-throwing — the docs are a cache; a failed
// rebuild self-heals on the next distill.
export function rebuildOrientDocsFor(repo: string | null): void {
  try {
    rebuildOrientDoc("global");
    if (repo) rebuildOrientDoc(orientScopeForRepo(repo));
  } catch (err) {
    console.warn(`[memory] orient-doc rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Read side, served by GET /v1/memory/orient-doc and spliced into orient().
export function getOrientDocs(repo: string | null): { global: string | null; repo: string | null } {
  const get = (scope: string): string | null =>
    (db.prepare(`SELECT content FROM orient_docs WHERE scope = ?`).get(scope) as { content: string } | undefined)
      ?.content ?? null;
  return { global: get("global"), repo: repo ? get(orientScopeForRepo(repo)) : null };
}

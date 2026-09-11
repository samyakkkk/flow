// anchors.ts — resolve the join between a memory/observation and graph nodes.
//
// DESIGN (final, user-approved):
//   flow.db is PRIMARY. The `anchors` table owns the item↔node edge; any graph
//   representation is a rebuildable projection. Resolution runs at consolidation
//   time and is DETERMINISTIC FIRST: match a memory's context_files (+ file-ish
//   retrieval_keys) against the anchor PATHS of graph nodes. Cap 3 anchors per
//   item; prefer the MOST SPECIFIC node (an endpoint under a service beats the
//   service). Generalizes to corpus observations (linear/slack) when files or
//   entities are inferable from their text.
//
//   Node anchor paths come from FalkorDB via the gateway. To keep this offline
//   and testable, resolution is behind an injectable NodeAnchorProvider: tests
//   stub it; the production impl queries the gateway/graph (nodes carry an
//   `evidence` = 'file:line' prop; its path is the anchor path). A null provider
//   (no graph reachable) → no anchors resolved, item falls back to repo-level.
//
//   RE-RESOLUTION is idempotent (callable on reindex): re-run matching from the
//   item's STORED context_files/keys, replace the edge set. A node that has
//   disappeared drops its edge; the item falls back to repo-level — never lost.

import { randomUUID } from "node:crypto";
import db from "../db.js";

export const MAX_ANCHORS_PER_ITEM = 3;

export type ItemType = "memory" | "observation";
export type AnchorSource = "files" | "semantic";

export interface AnchorRow {
  id: string;
  item_type: ItemType;
  item_id: string;
  node_id: string;
  source: AnchorSource;
  resolved_at: number;
}

// A graph node as seen for anchoring: its id and the set of file paths it is
// anchored to in the repo (derived from the node's `evidence` = 'file:line').
export interface NodeAnchor {
  node_id: string;
  // Repo-relative file paths this node covers (usually one; endpoints/services
  // may span a few). Lower-cased comparison happens in the matcher.
  paths: string[];
  // Larger = more specific. An endpoint (deeper id / path) outranks the service
  // that contains it when both match the same file. Provider supplies it; when
  // absent we derive a fallback from the id/path shape.
  specificity?: number;
}

// The seam to the graph. Production queries the gateway; tests stub it. Given a
// repo and a set of candidate file paths, return the graph nodes anchored to any
// of them. Returning [] (or a provider that throws → caught) means "graph
// unreachable / no match" and the item simply stays repo-level.
export interface NodeAnchorProvider {
  nodesForFiles(repo: string | null, files: string[]): Promise<NodeAnchor[]>;
}

// Default provider resolves nothing — production wires a gateway-backed one at
// boot (see anchor-provider.ts); tests inject their own stub.
let _provider: NodeAnchorProvider = { nodesForFiles: async () => [] };
export function setNodeAnchorProvider(p: NodeAnchorProvider): void {
  _provider = p;
}
export function getNodeAnchorProvider(): NodeAnchorProvider {
  return _provider;
}

// A token/path is "file-ish" if it looks like a path or a filename: contains a
// slash, or a dot with a short-ish extension. Bare words are NOT file-ish (they
// belong to the semantic path, not the deterministic file match).
export function isFileIsh(s: string): boolean {
  if (s.includes("/")) return true;
  return /\.[a-z0-9]{1,6}$/i.test(s);
}

// Basename of a path, lower-cased (for endpoint-vs-service tie handling and for
// matching a node whose path is stored as just a filename).
function basename(p: string): string {
  const clean = p.replace(/\\/g, "/");
  const i = clean.lastIndexOf("/");
  return (i >= 0 ? clean.slice(i + 1) : clean).toLowerCase();
}

// Derive a fallback specificity from a node id/path when the provider omits it:
// deeper ids (more ':' or '/' segments) are more specific. Endpoints look like
// 'api:svc:GET /x' (3 segments) and beat services 'svc:x' (1 segment).
function derivedSpecificity(node: NodeAnchor): number {
  if (typeof node.specificity === "number") return node.specificity;
  const idSegs = node.node_id.split(/[:/]/).filter(Boolean).length;
  const pathDepth = Math.max(0, ...node.paths.map((p) => p.split("/").length));
  return idSegs * 10 + pathDepth;
}

// The file set an item exposes for deterministic matching: context_files plus
// any file-ish retrieval_keys, deduped, normalized (basename kept as-is; full
// path kept too so both a stored full path and a stored basename can match).
export function candidateFiles(contextFiles: string[], retrievalKeys: string[]): string[] {
  const out = new Set<string>();
  for (const f of contextFiles) if (f && f.trim()) out.add(f.trim());
  for (const k of retrievalKeys) if (k && isFileIsh(k)) out.add(k.trim());
  return [...out];
}

// Do two path strings refer to the same file? Exact (lower-cased) OR one is the
// basename of the other OR they share a basename — the deterministic matcher
// wants "store.ts" to match "orchestrator/src/store.ts".
function pathsMatch(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  if (la.endsWith("/" + lb) || lb.endsWith("/" + la)) return true;
  return basename(a) === basename(b) && basename(a).includes(".");
}

// Pure ranking core: given the item's candidate files and the graph nodes those
// files hit, pick up to MAX_ANCHORS_PER_ITEM node ids, most-specific first.
// Exposed for unit tests (no DB, no provider).
export function rankAnchors(candidateFilesList: string[], nodes: NodeAnchor[]): string[] {
  const scored: Array<{ id: string; spec: number; matches: number }> = [];
  for (const node of nodes) {
    let matches = 0;
    for (const nf of node.paths) {
      if (candidateFilesList.some((cf) => pathsMatch(cf, nf))) matches++;
    }
    if (matches > 0) scored.push({ id: node.node_id, spec: derivedSpecificity(node), matches });
  }
  // Most specific first; break ties by match count, then by id for determinism.
  scored.sort((a, b) => b.spec - a.spec || b.matches - a.matches || (a.id < b.id ? -1 : 1));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scored) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s.id);
    if (out.length >= MAX_ANCHORS_PER_ITEM) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence

export function anchorsForItem(itemType: ItemType, itemId: string): AnchorRow[] {
  return db
    .prepare(`SELECT * FROM anchors WHERE item_type = ? AND item_id = ? ORDER BY resolved_at DESC, node_id`)
    .all(itemType, itemId) as AnchorRow[];
}

export function nodeIdsForItem(itemType: ItemType, itemId: string): string[] {
  return anchorsForItem(itemType, itemId).map((a) => a.node_id);
}

export function itemsAnchoredToNode(nodeId: string): AnchorRow[] {
  return db.prepare(`SELECT * FROM anchors WHERE node_id = ? ORDER BY resolved_at DESC`).all(nodeId) as AnchorRow[];
}

// Replace the anchor edge set for one item with `nodeIds` (idempotent). Runs in
// a transaction: delete the old edges, insert the new ones. Called by resolve
// AND re-resolve — re-resolution is just "resolve again from stored files".
export function setAnchors(itemType: ItemType, itemId: string, nodeIds: string[], source: AnchorSource): void {
  const capped = nodeIds.slice(0, MAX_ANCHORS_PER_ITEM);
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM anchors WHERE item_type = ? AND item_id = ?`).run(itemType, itemId);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO anchors (id, item_type, item_id, node_id, source, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const nodeId of capped) ins.run(randomUUID(), itemType, itemId, nodeId, source, now);
  });
  tx();
}

// ---------------------------------------------------------------------------
// Resolution (deterministic file match → anchor edges)

export interface ResolvableItem {
  item_type: ItemType;
  item_id: string;
  repo: string | null;
  context_files: string[];
  retrieval_keys: string[];
}

// Resolve (or re-resolve) one item's anchors from its files. Deterministic
// first: match candidate files against graph node anchor paths via the
// provider, rank most-specific, cap 3. Returns the node ids anchored (possibly
// []). Never throws — a provider error → [] and the item falls back to
// repo-level. Idempotent: re-running replaces the edge set, so a node that has
// since disappeared (provider no longer returns it) drops its edge.
export async function resolveItemAnchors(item: ResolvableItem): Promise<string[]> {
  const files = candidateFiles(item.context_files, item.retrieval_keys);
  if (files.length === 0) {
    // Nothing file-ish to anchor on — clear any stale edges, fall back to repo.
    setAnchors(item.item_type, item.item_id, [], "files");
    return [];
  }
  let nodes: NodeAnchor[] = [];
  try {
    nodes = await _provider.nodesForFiles(item.repo, files);
  } catch {
    // Graph unreachable → leave existing edges untouched on a live resolve is
    // tempting, but re-resolve semantics require we not lose the item; simplest
    // safe behavior is "no new edges this pass". Keep prior edges intact.
    return nodeIdsForItem(item.item_type, item.item_id);
  }
  const nodeIds = rankAnchors(files, nodes);
  setAnchors(item.item_type, item.item_id, nodeIds, "files");
  return nodeIds;
}

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Resolve anchors for a memory by id, reading its stored context from attached
// observations (union of context_files) + the memory's own retrieval_keys.
// Called at consolidation time and on re-resolve.
export async function resolveMemoryAnchors(memoryId: string): Promise<string[]> {
  const mem = db.prepare(`SELECT id, repo, retrieval_keys FROM memories WHERE id = ?`).get(memoryId) as
    | { id: string; repo: string | null; retrieval_keys: string | null }
    | undefined;
  if (!mem) return [];
  // context_files come from the attached observations (the memory row doesn't
  // store them; observations do).
  const obsRows = db
    .prepare(`SELECT context_files FROM observations WHERE memory_id = ?`)
    .all(memoryId) as Array<{ context_files: string | null }>;
  const ctxFiles = new Set<string>();
  for (const r of obsRows) for (const f of parseJsonArray(r.context_files)) ctxFiles.add(f);
  return resolveItemAnchors({
    item_type: "memory",
    item_id: mem.id,
    repo: mem.repo,
    context_files: [...ctxFiles],
    retrieval_keys: parseJsonArray(mem.retrieval_keys),
  });
}

// Resolve anchors for a corpus observation (linear/slack) by id. Files/entities
// are inferred from its context_files + file-ish retrieval_keys, same path.
export async function resolveObservationAnchors(observationId: string): Promise<string[]> {
  const obs = db
    .prepare(`SELECT id, repo, context_files, retrieval_keys FROM observations WHERE id = ?`)
    .get(observationId) as
    | { id: string; repo: string | null; context_files: string | null; retrieval_keys: string | null }
    | undefined;
  if (!obs) return [];
  return resolveItemAnchors({
    item_type: "observation",
    item_id: obs.id,
    repo: obs.repo,
    context_files: parseJsonArray(obs.context_files),
    retrieval_keys: parseJsonArray(obs.retrieval_keys),
  });
}

// Re-resolve every active memory's anchors (callable on reindex). Idempotent;
// nodes that disappeared drop their edges, items fall back to repo-level. Runs
// serially — reindex is not latency-critical. Returns a summary.
export async function reresolveAllMemoryAnchors(): Promise<{ items: number; anchored: number }> {
  const rows = db.prepare(`SELECT id FROM memories WHERE status = 'active'`).all() as Array<{ id: string }>;
  let anchored = 0;
  for (const r of rows) {
    const ids = await resolveMemoryAnchors(r.id);
    if (ids.length) anchored++;
  }
  return { items: rows.length, anchored };
}

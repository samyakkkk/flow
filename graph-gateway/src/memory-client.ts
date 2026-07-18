// memory-client.ts — the gateway's thin HTTP client to the orchestrator's
// memory surface (flow.db-backed). The gateway never touches flow.db directly;
// it proxies, matching the FLOW_NOTES_URL / search_knowledge precedent.
//
// IMPLEMENTATION CHOICE (Sections B/C/D): rather than PROJECT memories into
// FalkorDB (which would make the graph a second source of truth and require
// writes on every consolidation), the gateway MERGES memory data at read time by
// calling the orchestrator. flow.db stays primary; the graph stays a
// code-structure projection. These calls are best-effort: a null base URL or an
// unreachable orchestrator degrades gracefully (get_entity returns the node
// WITHOUT attachments; card lookups return not_found; find_entity merges nothing).

function base(): string | null {
  // FLOW_MEMORY_URL points at .../v1/memory/search; strip the trailing verb to
  // get the memory root. Fall back to ORCHESTRATOR_URL + /v1/memory.
  const memUrl = process.env.FLOW_MEMORY_URL;
  if (memUrl) return memUrl.replace(/\/search$/, "");
  const orch = process.env.ORCHESTRATOR_URL;
  if (orch) return `${orch.replace(/\/$/, "")}/v1/memory`;
  return null;
}

function token(): string {
  return process.env.FLOW_ACTIVITY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
}

function authHeaders(): Record<string, string> {
  const t = token();
  return { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) };
}

export interface HeadlineResult {
  node_id: string;
  rendered: string;
  hasAttachments: boolean;
  counts: { memories: number; tickets: number; threads: number };
}

// Node headline index (Section B). Returns null when memory is unreachable — the
// caller (get_entity) then serves the node WITHOUT attachments, gracefully.
export async function fetchHeadline(nodeId: string, timeoutMs = 3000): Promise<HeadlineResult | null> {
  const root = base();
  if (!root) return null;
  try {
    const res = await fetch(`${root}/headline/${encodeURIComponent(nodeId)}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as HeadlineResult;
  } catch {
    return null;
  }
}

export interface CardResult {
  status: "found" | "not_found";
  type: string;
  id: string;
  card?: Record<string, unknown>;
}

// Drill-down card (Section C) for a mem:/obs:/lin:/slackthread: id. Returns a
// not_found sentinel on any failure so batch get_entity can slot an explicit
// not_found entry rather than dropping the id.
export async function fetchCard(type: string, id: string, timeoutMs = 3000): Promise<CardResult> {
  const root = base();
  if (!root) return { status: "not_found", type, id };
  try {
    const res = await fetch(`${root}/card/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { status: "not_found", type, id };
    if (!res.ok) return { status: "not_found", type, id };
    return (await res.json()) as CardResult;
  } catch {
    return { status: "not_found", type, id };
  }
}

export interface MemoryHitLine {
  type: "memory";
  kind: string;
  headline: string;
  tier: string;
  id: string;
  line: string;
}

export interface MemoryHitGroup {
  query: string;
  hits: MemoryHitLine[];
}

// find_entity memory merge (Section D). Single or batch. Returns [] on failure
// (find_entity then just shows graph nodes — no memory rows blended in).
export async function fetchMemoryHits(
  queries: string[],
  repo: string | null,
  timeoutMs = 4000,
): Promise<MemoryHitGroup[]> {
  const root = base();
  if (!root || queries.length === 0) return [];
  try {
    const single = queries.length === 1;
    const res = await fetch(`${root}/hits`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(single ? { query: queries[0], repo } : { queries, repo }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { hits?: MemoryHitLine[]; groups?: MemoryHitGroup[] };
    if (single) return [{ query: queries[0], hits: body.hits ?? [] }];
    return body.groups ?? [];
  } catch {
    return [];
  }
}

// A card id namespace is one of these prefixes. get_entity dispatches an id to
// the orchestrator when it matches; otherwise it's a graph node id.
const CARD_TYPES = new Set(["mem", "obs", "lin", "slackthread"]);
export function parseCardId(raw: string): { type: string; id: string } | null {
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const type = raw.slice(0, i);
  if (!CARD_TYPES.has(type)) return null;
  const id = raw.slice(i + 1);
  if (!id) return null;
  return { type, id };
}

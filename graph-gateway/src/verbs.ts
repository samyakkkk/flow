import { z } from "zod";
import { DEFAULT_GRAPH, deletedGraphError, run } from "./graph.js";
import { record } from "./journal.js";
import { EDGE_TYPES, NODE_TYPES, isEdgeType, isNodeType } from "./schema.js";
import { embedQuery, embedText, embeddingsEnabled, entityText } from "./embed.js";
import {
  fetchHeadline,
  fetchCard,
  fetchMemoryHits,
  parseCardId,
  type MemoryHitGroup,
} from "./memory-client.js";

// Cosine-distance ceiling for semantic matches. Tuned on the flow graph (156
// nodes) by sweeping a 24-query labelled set: recall climbs steeply up to ~0.65
// (hit@3 88%, 0 regressions) then flattens while noise keeps rising, so 0.65 is
// the knee. text-embedding-3-small puts genuinely related items in ~0.40–0.65
// and unrelated ones past ~0.72. Tunable via env for re-tuning on other graphs.
const VECTOR_MAX_DISTANCE = Number(process.env.FLOW_VECTOR_MAX_DISTANCE ?? 0.65);

// Typed verbs are the only way anything mutates the graph. Every write
// requires provenance and lands in the journal. Node/edge types are validated
// against the schema whitelist before they are ever interpolated into Cypher
// (labels and relationship types cannot be bound as params).

const provenanceShape = {
  actor: z.string().min(1).describe("Who is writing, e.g. 'opencode:graph-builder:<sessionID>'"),
  evidence: z.string().optional().describe("Where this claim comes from, e.g. 'repo file:line' or a Slack permalink"),
  confidence: z.enum(["high", "medium", "low"]).optional(),
};

const scalar = z.union([z.string(), z.number(), z.boolean()]);

// Keys the gateway owns; client-supplied props may not shadow them.
const RESERVED = new Set(["id", "name", "aliases", "description", "created_by", "updated_by", "created_at", "updated_at", "evidence", "confidence"]);

function cleanProps(props: Record<string, string | number | boolean> | undefined) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (!RESERVED.has(k) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) out[k] = v;
  }
  return out;
}

interface EntityRow {
  type: unknown;
  id: unknown;
  name: unknown;
  description: unknown;
  anchor?: unknown; // file:line evidence — makes find_entity a semantic code search
}

// A found row plus optional retrieval metadata: `via` says which pass surfaced
// it (lexical substring vs. semantic vector) and `distance` is the cosine
// distance for vector hits (lower = closer). Both are additive — existing
// callers that only read type/id/name/description are unaffected.
interface ScoredRow extends EntityRow {
  via?: "lexical" | "vector";
  distance?: number;
}

const clampLimit = (limit: number) => Math.max(1, Math.min(50, Math.floor(limit)));

// Run `fn` over `items` with a small concurrency bound, preserving input order
// in the result. Used by the batched read verbs so a model can fetch several
// entities/queries in one call without us firing an unbounded fan-out at the
// graph. Errors are captured per item (Promise.allSettled semantics), never
// propagated — a batch is a set of independent reads and one bad item must not
// sink the rest.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const out: Array<{ ok: true; value: R } | { ok: false; error: string }> = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        out[i] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// Read verbs accept a single value OR a batch array. These caps bound the
// server-side fan-out; over the cap is a hard error (clear failure beats a
// silent truncation the model can't see). Concurrency is deliberately small —
// a batch is a convenience for the model, not a load-test of the graph.
const GET_ENTITY_MAX_BATCH = 15;
const FIND_ENTITY_MAX_BATCH = 10;
const BATCH_CONCURRENCY = 5;

// Proposed-but-unblessed procedures are invisible to normal retrieval — they
// only enter circulation once a human approves them. Label-scoped to Procedure:
// other node types may legitimately carry a status prop (cleanProps allows it)
// and must not vanish from search. Dedup paths opt back in (includeProposed)
// so a second agent proposing the same rule sees the pending one instead of
// creating a duplicate.
const HIDE_PROPOSED = `AND NOT (labels(n)[0] = 'Procedure' AND coalesce(n.status, '') = 'proposed')`;

async function findSimilar(graph: string, q: string, type?: string, limit = 10, includeProposed = false): Promise<EntityRow[]> {
  // Tokenized match: every query token must appear in the same field. Ids and
  // names carry separator conventions the caller can't guess ("brands-live",
  // "brandsLive", "Brands.Live") — splitting the query on non-alphanumerics
  // lets "brands live" reach all of them. This pass is the only retrieval left
  // when embeddings are down, so it must not be defeated by punctuation.
  // Strictly widens the old whole-phrase CONTAINS: any field containing the
  // full query contains each token. Punctuation-only queries keep the raw scan.
  const tokens = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const fields = ["toLower(n.id)", "toLower(n.name)", "toLower(coalesce(n.aliases, ''))"];
  const match = tokens.length > 0
    ? fields.map((f) => tokens.map((_, i) => `${f} CONTAINS $t${i}`).join(" AND ")).map((c) => `(${c})`).join(" OR ")
    : fields.map((f) => `${f} CONTAINS $ql`).join(" OR ");
  const typeFilter = type ? `AND labels(n)[0] = $type` : "";
  const rows = await run(
    graph,
    `MATCH (n) WHERE (${match}) ${typeFilter} ${includeProposed ? "" : HIDE_PROPOSED}
     RETURN labels(n)[0] AS type, n.id AS id, n.name AS name, n.description AS description, n.evidence AS anchor
     LIMIT ${clampLimit(limit)}`,
    {
      ...(tokens.length > 0 ? Object.fromEntries(tokens.map((t, i) => [`t${i}`, t])) : { ql: q.toLowerCase() }),
      ...(type ? { type } : {}),
    },
  );
  return rows as unknown as EntityRow[];
}

// Semantic search: embed the query, then rank nodes by cosine distance to their
// stored embedding. This is what rescues queries whose words appear nowhere in
// the graph ("worktree" → the repo-checkout / agent-session nodes). Brute-force
// over nodes carrying an embedding — exact (no HNSW recall loss) and instant at
// the hundreds-to-thousands of nodes a project graph holds. When embeddings are
// unconfigured or the query can't be embedded, `degraded` says why — callers
// that answer retrieval questions must pass that on, because lexical-only
// results are indistinguishable from "the graph has nothing" otherwise.
async function findByVector(graph: string, q: string, type: string | undefined, limit: number, includeProposed = false): Promise<{ rows: ScoredRow[]; degraded?: string }> {
  if (!embeddingsEnabled()) return { rows: [], degraded: "local embedding service is not configured" };
  const { vec, error } = await embedQuery(q);
  if (!vec) return { rows: [], degraded: error ?? "query could not be embedded" };
  const typeFilter = type ? `AND labels(n)[0] = $type` : "";
  const rows = await run(
    graph,
    `MATCH (n) WHERE n.embedding IS NOT NULL ${typeFilter} ${includeProposed ? "" : HIDE_PROPOSED}
     WITH n, vec.cosineDistance(n.embedding, vecf32($vec)) AS d
     WHERE d <= $maxDistance
     RETURN labels(n)[0] AS type, n.id AS id, n.name AS name, n.description AS description, n.evidence AS anchor, d AS distance
     ORDER BY d ASC
     LIMIT ${clampLimit(limit)}`,
    { vec, maxDistance: VECTOR_MAX_DISTANCE, ...(type ? { type } : {}) },
  );
  const scored = (rows as unknown as ScoredRow[]).map((r) => ({
    ...r,
    via: "vector" as const,
    distance: typeof r.distance === "number" ? Math.round(r.distance * 1000) / 1000 : r.distance,
  }));
  return { rows: scored };
}

// ---------------------------------------------------------------------------

const findEntityInput = {
  // Single query OR a batch: pass `qs` to look up several phrases in one call.
  // At least one form is required; `q` wins when both are given.
  q: z.string().min(1).optional().describe("Name, id, or phrase to look up (single form)"),
  qs: z.array(z.string().min(1)).min(1).max(FIND_ENTITY_MAX_BATCH).optional().describe(`Phrases to look up in one call (batch form, ≤${FIND_ENTITY_MAX_BATCH}) — prefer one batched call over sequential single searches`),
  type: z.string().optional().describe("Optional node type filter, e.g. 'Service'"),
  limit: z.number().int().min(1).max(50).default(10),
  graph: z.string().default(DEFAULT_GRAPH),
};

// Single-query lookup — the one code path both the single and batch forms reuse.
async function findEntityOne(graph: string, q: string, type: string | undefined, limit: number) {
  const exact = await run(
    graph,
    `MATCH (n {id: $q}) RETURN labels(n)[0] AS type, n.id AS id, n.name AS name, n.description AS description, n.evidence AS anchor`,
    { q },
  );
  if (exact.length > 0) return { status: "exact" as const, matches: exact as unknown as ScoredRow[] };

  // Lexical substring first — it's a high-precision signal when the caller
  // already knows a name/id fragment. Then augment with semantic matches the
  // substring scan can't reach. Lexical hits keep their rank; vector hits fill
  // the remaining slots, deduped by id.
  const lexical: ScoredRow[] = (await findSimilar(graph, q, type, limit)).map(
    (r) => ({ ...r, via: "lexical" }),
  );
  const { rows: vector, degraded } = await findByVector(graph, q, type, limit);

  const seen = new Set(lexical.map((r) => String(r.id)));
  const matches: ScoredRow[] = [...lexical];
  for (const v of vector) {
    if (matches.length >= limit) break;
    if (seen.has(String(v.id))) continue;
    seen.add(String(v.id));
    matches.push(v);
  }
  return {
    status: (matches.length > 0 ? "similar" : "none") as "similar" | "none",
    matches,
    ...(degraded
      ? { warning: `Semantic search unavailable (${degraded}) — these results are substring-only and may miss related nodes. Do not conclude the graph lacks coverage from this response.` }
      : {}),
  };
}

// The repo scope for memory hits — session env, since find_entity has no repo
// param. The orchestrator's family gate is lenient (same product family) so a
// missing repo just widens eligibility.
function memoryRepo(): string | null {
  return process.env.FLOW_REPO || null;
}

async function findEntity(input: z.infer<z.ZodObject<typeof findEntityInput>>) {
  if (input.q === undefined && input.qs === undefined) {
    return { status: "error", error: "Pass `q` (single) or `qs` (batch, up to 10)." };
  }
  // UNIFIED find_entity (Section D): graph nodes AND memory hits in one result.
  // Memory hits are fetched from the orchestrator (family gate + 0.55 silence
  // gate + meaningful-token FTS reused, not forked) with the type QUOTA applied
  // there; the gateway just splices them in as `memory_hits`. Graph node search
  // is unchanged — memory is additive, never replaces code nodes.

  // Single form stays byte-for-byte compatible for graph fields ({status,
  // matches, warning?}); `memory_hits` is an additive field.
  if (input.q !== undefined) {
    const [graphRes, hitGroups] = await Promise.all([
      findEntityOne(input.graph, input.q, input.type, input.limit),
      fetchMemoryHits([input.q], memoryRepo()),
    ]);
    const hits = hitGroups[0]?.hits ?? [];
    return hits.length ? { ...graphRes, memory_hits: hits.map((h) => h.line) } : graphRes;
  }

  // Batch: one group per query, in REQUEST ORDER. Cross-group duplicate node
  // ids are noted tersely ("(also matched q1)") instead of repeating the full
  // entry — the first group to surface an id owns the full match; later groups
  // just point back. A per-query failure is isolated to that group.
  const qs = input.qs as string[];
  const [settled, hitGroups] = await Promise.all([
    mapWithConcurrency(qs, BATCH_CONCURRENCY, (q) => findEntityOne(input.graph, q, input.type, input.limit)),
    fetchMemoryHits(qs, memoryRepo()),
  ]);
  const hitsByQuery = memoryHitsByQuery(qs, hitGroups);

  const firstSeenIn = new Map<string, number>(); // node id → group index that owns the full entry
  const groups = settled.map((r, i) => {
    const memHits = hitsByQuery[i] ?? [];
    const memField = memHits.length ? { memory_hits: memHits.map((h) => h.line) } : {};
    if (!r.ok) return { query: qs[i], status: "error" as const, error: r.error, ...memField };
    const res = r.value;
    const matches = res.matches.map((m) => {
      const id = String(m.id);
      const owner = firstSeenIn.get(id);
      if (owner === undefined) {
        firstSeenIn.set(id, i);
        return m;
      }
      // Terse cross-group dedup note — full entry lives in the owning group.
      return { id: m.id, note: `(also matched q${owner + 1})` };
    });
    return { query: qs[i], status: res.status, matches, ...("warning" in res ? { warning: res.warning } : {}), ...memField };
  });

  return { status: "batch", count: groups.length, groups };
}

// Align memory-hit groups to the query list by index; the orchestrator returns
// them in request order, but be defensive (match by query text as a fallback).
function memoryHitsByQuery(qs: string[], groups: MemoryHitGroup[]): Array<MemoryHitGroup["hits"]> {
  if (groups.length === qs.length) return groups.map((g) => g.hits);
  const byQuery = new Map(groups.map((g) => [g.query, g.hits]));
  return qs.map((q) => byQuery.get(q) ?? []);
}

// ---------------------------------------------------------------------------

const upsertEntityInput = {
  type: z.string().describe(`One of: ${NODE_TYPES.join(", ")}`),
  id: z.string().min(1).describe("Stable id, convention '<kind>:<name>' e.g. 'svc:users'"),
  name: z.string().min(1),
  description: z.string().optional().describe("One paragraph a teammate could learn from — this powers retrieval"),
  aliases: z.array(z.string()).optional().describe("Other names humans use for this thing"),
  props: z.record(scalar).optional(),
  provenance: z.object(provenanceShape),
  confirm: z.boolean().default(false).describe("Set true to create anyway after reviewing similar_exists candidates"),
  graph: z.string().default(DEFAULT_GRAPH),
};

async function upsertEntity(input: z.infer<z.ZodObject<typeof upsertEntityInput>>) {
  const deleted = await deletedGraphError(input.graph);
  if (deleted) return { status: "error", error: deleted };
  if (!isNodeType(input.type)) {
    return { status: "error", error: `Unknown node type '${input.type}'. Allowed: ${NODE_TYPES.join(", ")}` };
  }
  // The bless lifecycle is enforced HERE, not by prompt discipline: if upsert
  // could create or update Procedures, any writer could mint a fake-blessed
  // insert-mode procedure and have it auto-injected into future sessions.
  if (input.type === "Procedure") {
    return { status: "error", error: "Procedures enter through propose_procedure (and are edited via human review), never upsert_entity." };
  }
  const props = cleanProps(input.props);
  const aliases = input.aliases?.join(", ");
  const existing = await run(input.graph, `MATCH (n {id: $id}) RETURN labels(n)[0] AS type`, { id: input.id });

  let status: string;
  let candidates: EntityRow[] = [];

  if (existing.length > 0) {
    if (existing[0].type !== input.type) {
      return { status: "error", error: `id '${input.id}' already exists with type '${existing[0].type}', not '${input.type}'` };
    }
    await run(
      input.graph,
      `MATCH (n {id: $id}) SET n += $props, n.name = $name, n.updated_by = $actor, n.updated_at = $ts
       ${input.description !== undefined ? ", n.description = $description" : ""}
       ${aliases !== undefined ? ", n.aliases = $aliases" : ""}
       ${input.provenance.evidence !== undefined ? ", n.evidence = $evidence" : ""}
       ${input.provenance.confidence !== undefined ? ", n.confidence = $confidence" : ""}`,
      {
        id: input.id, props, name: input.name, actor: input.provenance.actor, ts: new Date().toISOString(),
        description: input.description ?? null, aliases: aliases ?? null,
        evidence: input.provenance.evidence ?? null, confidence: input.provenance.confidence ?? null,
      },
    );
    status = "updated";
  } else {
    // Dedup gate: same thing under a different id is the failure mode that
    // rots auto-built graphs. Similar candidates block the write unless the
    // caller confirms it is genuinely new.
    candidates = (await findSimilar(input.graph, input.name, input.type, 5, true)).filter((c) => c.id !== input.id);
    if (candidates.length > 0 && !input.confirm) {
      return {
        status: "similar_exists",
        candidates,
        hint: "If one of these is the same thing, upsert with its id instead. If genuinely new, retry with confirm: true.",
      };
    }
    await run(
      input.graph,
      `CREATE (n:${input.type} {id: $id, name: $name, created_by: $actor, created_at: $ts})
       SET n += $props
       ${input.description !== undefined ? ", n.description = $description" : ""}
       ${aliases !== undefined ? ", n.aliases = $aliases" : ""}
       ${input.provenance.evidence !== undefined ? ", n.evidence = $evidence" : ""}
       ${input.provenance.confidence !== undefined ? ", n.confidence = $confidence" : ""}`,
      {
        id: input.id, name: input.name, actor: input.provenance.actor, ts: new Date().toISOString(), props,
        description: input.description ?? null, aliases: aliases ?? null,
        evidence: input.provenance.evidence ?? null, confidence: input.provenance.confidence ?? null,
      },
    );
    status = "created";
  }

  await embedNode(input.graph, input.id);
  await record({ graph: input.graph, actor: input.provenance.actor, verb: "upsert_entity", input: { type: input.type, id: input.id, name: input.name }, status });
  return { status, id: input.id };
}

// Compute and store the semantic vector for a node. Best-effort: never throws,
// never blocks a write. Reads the node back first so the embedding always
// reflects what was actually persisted (an update may leave description/aliases
// unchanged, so we can't rely on the input alone).
async function embedNode(graph: string, id: string): Promise<void> {
  if (!embeddingsEnabled()) return;
  try {
    const cur = await run(
      graph,
      `MATCH (n {id: $id}) RETURN labels(n)[0] AS type, n.name AS name, n.description AS description, n.aliases AS aliases, n.trigger AS trigger`,
      { id },
    );
    const row = cur[0];
    if (!row) return;
    const vec = await embedText(
      entityText(String(row.type), String(row.name ?? ""), row.description as string, row.aliases as string, row.trigger as string),
    );
    if (!vec) return;
    await run(graph, `MATCH (n {id: $id}) SET n.embedding = vecf32($vec)`, { id, vec });
  } catch (err) {
    console.warn(`[embed] node ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------

const upsertRelationInput = {
  type: z.string().describe(`One of: ${EDGE_TYPES.join(", ")}`),
  from: z.string().describe("id of the source node (must exist)"),
  to: z.string().describe("id of the target node (must exist)"),
  props: z.record(scalar).optional(),
  provenance: z.object(provenanceShape),
  graph: z.string().default(DEFAULT_GRAPH),
};

async function upsertRelation(input: z.infer<z.ZodObject<typeof upsertRelationInput>>) {
  const deleted = await deletedGraphError(input.graph);
  if (deleted) return { status: "error", error: deleted };
  if (!isEdgeType(input.type)) {
    return { status: "error", error: `Unknown edge type '${input.type}'. Allowed: ${EDGE_TYPES.join(", ")}` };
  }
  const ends = await run(
    input.graph,
    `OPTIONAL MATCH (a {id: $from}) OPTIONAL MATCH (b {id: $to}) RETURN a.id AS a, b.id AS b`,
    { from: input.from, to: input.to },
  );
  const missing = [
    ...(ends[0]?.a ? [] : [input.from]),
    ...(ends[0]?.b ? [] : [input.to]),
  ];
  if (missing.length > 0) {
    return { status: "error", error: `Missing nodes: ${missing.join(", ")}. Create them with upsert_entity first (or check ids with find_entity).` };
  }
  await run(
    input.graph,
    `MATCH (a {id: $from}), (b {id: $to})
     MERGE (a)-[r:${input.type}]->(b)
     SET r += $props, r.updated_by = $actor, r.updated_at = $ts
     ${input.provenance.evidence !== undefined ? ", r.evidence = $evidence" : ""}
     ${input.provenance.confidence !== undefined ? ", r.confidence = $confidence" : ""}`,
    {
      from: input.from, to: input.to, props: cleanProps(input.props),
      actor: input.provenance.actor, ts: new Date().toISOString(),
      evidence: input.provenance.evidence ?? null, confidence: input.provenance.confidence ?? null,
    },
  );
  await record({ graph: input.graph, actor: input.provenance.actor, verb: "upsert_relation", input: { type: input.type, from: input.from, to: input.to }, status: "merged" });
  return { status: "merged" };
}

// ---------------------------------------------------------------------------

const getEntityInput = {
  // Single id OR a batch: pass `ids` to fetch several nodes concurrently in one
  // call. At least one form is required; `id` wins when both are given.
  id: z.string().min(1).optional().describe("Node id to fetch (single form)"),
  ids: z.array(z.string().min(1)).min(1).max(GET_ENTITY_MAX_BATCH).optional().describe(`Node ids to fetch in one call (batch form, ≤${GET_ENTITY_MAX_BATCH}) — prefer one batched call over sequential single lookups`),
  graph: z.string().default(DEFAULT_GRAPH),
};

// The stored vector is retrieval machinery, not knowledge — never ship ~1536
// floats back to a caller.
function stripEmbedding<T extends { props?: unknown }>(row: T): T {
  const props = row.props as Record<string, unknown> | undefined;
  if (props && typeof props === "object") delete props.embedding;
  return row;
}

// Single-node fetch — the one code path both the single and batch forms reuse.
// Also the dispatch point for the memory id NAMESPACES (mem:/obs:/lin:/
// slackthread:): those aren't graph nodes, so we resolve them to drill-down
// cards via the orchestrator (Section C). Everything else is a graph node, and
// after its relations we append the HEADLINE INDEX (Section B) — memories/
// tickets/threads anchored to it, headlines only. If memory is unreachable the
// node returns WITHOUT attachments (graceful; a note says so).
async function getEntityOne(graph: string, id: string) {
  // Card namespace? Resolve a drill-down card instead of a graph lookup.
  const card = parseCardId(id);
  if (card) {
    const c = await fetchCard(card.type, card.id);
    if (c.status === "not_found") return { status: "not_found" as const, id };
    return { status: "found" as const, id, card: c.card, card_type: c.type };
  }

  const node = await run(graph, `MATCH (n {id: $id}) RETURN labels(n)[0] AS type, properties(n) AS props`, { id });
  if (node.length === 0) return { status: "not_found" as const, id };
  stripEmbedding(node[0] as { props?: unknown });
  const out = await run(
    graph,
    `MATCH ({id: $id})-[r]->(m) RETURN type(r) AS rel, labels(m)[0] AS type, m.id AS id, m.name AS name, properties(r) AS props`,
    { id },
  );
  const inc = await run(
    graph,
    `MATCH ({id: $id})<-[r]-(m) RETURN type(r) AS rel, labels(m)[0] AS type, m.id AS id, m.name AS name, properties(r) AS props`,
    { id },
  );

  // Headline index (Section B). Best-effort + fast (in-process cache on the
  // orchestrator, <20ms target). Only attach when there's something to show;
  // an unreachable source yields a terse "attachments unavailable" note.
  const base = { status: "found" as const, id, node: node[0], outgoing: out, incoming: inc };
  const headline = await fetchHeadline(id);
  if (headline === null) return { ...base, attachments: "unavailable" };
  if (!headline.hasAttachments) return base;
  return { ...base, attachments: headline.rendered, attachment_counts: headline.counts };
}

async function getEntity(input: z.infer<z.ZodObject<typeof getEntityInput>>) {
  if (input.id === undefined && input.ids === undefined) {
    return { status: "error", error: "Pass `id` (single) or `ids` (batch, up to 15)." };
  }
  // Single form stays byte-for-byte compatible: {status, node, outgoing, incoming}.
  if (input.id !== undefined) {
    const { id: _id, ...rest } = await getEntityOne(input.graph, input.id);
    return rest;
  }

  // Batch: results in REQUEST ORDER, one section per id. A missing id is an
  // explicit "not_found" entry (never silently dropped); a per-id failure is
  // isolated to that section. Duplicate ids in the request are honored as-is —
  // the model asked for them, and dropping would break positional pairing.
  const ids = input.ids as string[];
  const settled = await mapWithConcurrency(ids, BATCH_CONCURRENCY, (id) => getEntityOne(input.graph, id));
  const results = settled.map((r, i) =>
    r.ok ? r.value : { status: "error" as const, id: ids[i], error: r.error },
  );
  return {
    status: "batch",
    count: results.length,
    found: results.filter((r) => r.status === "found").length,
    not_found: results.filter((r) => r.status === "not_found").map((r) => r.id),
    results,
  };
}

// ---------------------------------------------------------------------------

const readQueryInput = {
  cypher: z.string().min(1).describe("Read-only Cypher (MATCH/RETURN). Writes are rejected — use the upsert verbs."),
  graph: z.string().default(DEFAULT_GRAPH),
};

async function readQuery(input: z.infer<z.ZodObject<typeof readQueryInput>>) {
  if (/\b(create|merge|set|delete|remove|drop|call)\b/i.test(input.cypher)) {
    return { status: "error", error: "Write/procedure keywords are not allowed here. Mutate via upsert_entity / upsert_relation." };
  }
  const rows = await run(input.graph, input.cypher);
  return { status: "ok", rows };
}

// ---------------------------------------------------------------------------

const mergeEntitiesInput = {
  keep: z.string().describe("id of the canonical node to keep"),
  remove: z.string().describe("id of the duplicate/placeholder node to merge away"),
  provenance: z.object(provenanceShape),
  graph: z.string().default(DEFAULT_GRAPH),
};

// Consolidates two nodes that turned out to be the same real-world thing
// (e.g. an ExternalService placeholder created before the real Service was
// indexed). Rewires every edge from `remove` onto `keep`, fills props `keep`
// lacks, folds the removed id/name into aliases, then deletes `remove`.
async function mergeEntities(input: z.infer<z.ZodObject<typeof mergeEntitiesInput>>) {
  const deleted = await deletedGraphError(input.graph);
  if (deleted) return { status: "error", error: deleted };
  if (input.keep === input.remove) return { status: "error", error: "keep and remove are the same id" };
  const nodes = await run(
    input.graph,
    `OPTIONAL MATCH (a {id: $keep}) OPTIONAL MATCH (b {id: $remove})
     RETURN properties(a) AS keepProps, properties(b) AS removeProps, labels(a)[0] AS keepType, labels(b)[0] AS removeType`,
    { keep: input.keep, remove: input.remove },
  );
  const keepProps = nodes[0]?.keepProps as Record<string, unknown> | null;
  const removeProps = nodes[0]?.removeProps as Record<string, unknown> | null;
  if (!keepProps || !removeProps) {
    return { status: "error", error: `Missing nodes: ${[!keepProps && input.keep, !removeProps && input.remove].filter(Boolean).join(", ")}` };
  }
  // merge deletes the `remove` node — which would be a back door around the
  // human-only procedure lifecycle (delete = review_procedure reject, via the
  // Inbox). Same enforcement rationale as the Procedure check in upsert.
  if (nodes[0]?.keepType === "Procedure" || nodes[0]?.removeType === "Procedure") {
    return { status: "error", error: "Procedures cannot be merged — their lifecycle (including deletion) is human-only via review_procedure." };
  }

  const out = await run(input.graph, `MATCH ({id: $id})-[r]->(m) RETURN type(r) AS t, properties(r) AS props, m.id AS other`, { id: input.remove });
  const inc = await run(input.graph, `MATCH ({id: $id})<-[r]-(m) RETURN type(r) AS t, properties(r) AS props, m.id AS other`, { id: input.remove });
  let rewired = 0;
  const skipped: string[] = [];
  for (const [rows, dir] of [[out, "out"], [inc, "in"]] as const) {
    for (const row of rows) {
      const t = String(row.t);
      const other = String(row.other);
      if (other === input.keep) { skipped.push(`${t} (would self-loop)`); continue; }
      if (!isEdgeType(t)) { skipped.push(`${t} (not in schema)`); continue; }
      const pattern = dir === "out" ? `(a)-[r:${t}]->(b)` : `(a)<-[r:${t}]-(b)`;
      await run(
        input.graph,
        `MATCH (a {id: $keep}), (b {id: $other}) MERGE ${pattern} SET r += $props, r.updated_by = $actor, r.updated_at = $ts`,
        { keep: input.keep, other, props: row.props ?? {}, actor: input.provenance.actor, ts: new Date().toISOString() },
      );
      rewired++;
    }
  }

  // Fill gaps in keep's props from remove; never overwrite what keep has.
  const fill: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(removeProps)) {
    if (!(k in keepProps) && !["id", "created_by", "created_at", "updated_by", "updated_at"].includes(k)) fill[k] = v;
  }
  const mergedAliases = [
    ...String(keepProps.aliases ?? "").split(",").map((s) => s.trim()),
    ...String(removeProps.aliases ?? "").split(",").map((s) => s.trim()),
    String(removeProps.name ?? ""),
    input.remove,
  ].filter((s, i, arr) => s && arr.indexOf(s) === i);

  await run(
    input.graph,
    `MATCH (n {id: $keep}) SET n += $fill, n.aliases = $aliases, n.merged_from = $remove, n.updated_by = $actor, n.updated_at = $ts`,
    { keep: input.keep, fill, aliases: mergedAliases.join(", "), remove: input.remove, actor: input.provenance.actor, ts: new Date().toISOString() },
  );
  await run(input.graph, `MATCH (n {id: $id}) DETACH DELETE n`, { id: input.remove });

  await record({ graph: input.graph, actor: input.provenance.actor, verb: "merge_entities", input: { keep: input.keep, remove: input.remove }, status: "merged" });
  return { status: "merged", keep: input.keep, removed: input.remove, rewired, skipped };
}

// ---------------------------------------------------------------------------
// Procedures — prescriptive, human-blessed knowledge ("when you do X, do Y").
// Unlike code-derived nodes they cannot be verified by reindexing, so they
// carry a bless lifecycle: agents PROPOSE fully-drafted procedures (status
// "proposed", invisible to normal retrieval until blessed), humans review in
// the dashboard inbox and APPROVE (status "blessed") or REJECT (delete; the
// journal keeps the record). The proposing agent drafts the complete artifact
// because it alone holds the conversational context the procedure came from.

const procedureSlug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

// Partition ids into existing/missing with ONE query instead of one per id.
async function partitionByExistence(graph: string, ids: string[]): Promise<{ found: string[]; missing: string[] }> {
  if (ids.length === 0) return { found: [], missing: [] };
  const rows = await run(graph, `MATCH (n) WHERE n.id IN $ids RETURN n.id AS id`, { ids });
  const found = new Set(rows.map((r) => String(r.id)));
  return { found: ids.filter((id) => found.has(id)), missing: ids.filter((id) => !found.has(id)) };
}

const proposeProcedureInput = {
  name: z.string().min(1).describe("Short imperative title, e.g. 'Run migrations against a prod snapshot before deploy'"),
  description: z.string().min(1).describe("Why this rule exists — 2-3 sentences a teammate could learn from"),
  trigger: z.string().min(1).describe("When-clause for retrieval, phrased like a task: 'when adding or changing a DB migration'"),
  steps: z.array(z.string().min(1)).min(1).describe("The ordered steps, complete enough to act on without asking"),
  scope: z.enum(["repo", "project"]).default("repo").describe("'repo' = applies to one repository, 'project' = team-wide"),
  mode: z.enum(["insert", "retrieve"]).default("retrieve").describe("'insert' = Flow pushes this into sessions when the task matches (safety-critical rules); 'retrieve' = found on demand (the default)"),
  governs: z.array(z.string()).optional().describe("Node ids this procedure governs — ONLY nodes where 'if you touch this, read me first' holds, not everything the text mentions"),
  source_quote: z.string().optional().describe("What the human actually said, verbatim — the provenance of the rule"),
  repo: z.string().optional().describe("Repository name this applies to (for scope 'repo')"),
  provenance: z.object(provenanceShape),
  confirm: z.boolean().default(false).describe("Set true to propose anyway after reviewing similar_exists candidates"),
  graph: z.string().default(DEFAULT_GRAPH),
};

async function proposeProcedure(input: z.infer<z.ZodObject<typeof proposeProcedureInput>>) {
  const id = `proc:${procedureSlug(input.name)}`;
  const existing = await run(input.graph, `MATCH (n {id: $id}) RETURN labels(n)[0] AS type`, { id });
  if (existing.length > 0) {
    return {
      status: "error",
      error: `'${id}' already exists. Procedures are edited through human review (dashboard inbox), not re-proposed — pick a different name if this is genuinely a new rule.`,
    };
  }
  // Dedup: lexical CONTAINS alone misses near-identical names ("…before
  // deploy" vs "…before deploying"), so also match semantically on name +
  // trigger. The two passes are independent — run them concurrently.
  // (findByVector self-noops to no rows when embeddings are unconfigured.)
  const [lexical, vecResult] = await Promise.all([
    findSimilar(input.graph, input.name, "Procedure", 5, true),
    findByVector(input.graph, `${input.name}\n${input.trigger}`, "Procedure", 5, true),
  ]);
  const candidates = [
    ...lexical,
    ...vecResult.rows.filter((v) => !lexical.some((l) => l.id === v.id)),
  ].filter((c) => c.id !== id);
  if (candidates.length > 0 && !input.confirm) {
    return {
      status: "similar_exists",
      candidates,
      hint: "A similar procedure may already cover this. If it does, stop. If genuinely new, retry with confirm: true.",
    };
  }

  // Validate GOVERNS targets now (the proposer should hear about typos), but
  // store them as a pending prop — edges materialize only on approval, so an
  // unblessed proposal never ambushes agents reading a governed node.
  const { found: valid, missing } = await partitionByExistence(input.graph, input.governs ?? []);

  // Steps are stored as plain newline-joined lines; numbering is a rendering
  // concern (UI / injection), not storage format.
  const steps = input.steps.join("\n");
  await run(
    input.graph,
    `CREATE (n:Procedure {
       id: $id, name: $name, description: $description, trigger: $trigger, steps: $steps,
       scope: $scope, mode: $mode, status: 'proposed', governs_pending: $governs,
       created_by: $actor, created_at: $ts
     })
     ${input.source_quote !== undefined ? "SET n.source_quote = $source_quote" : ""}
     ${input.repo !== undefined ? "SET n.repo = $repo" : ""}
     ${input.provenance.evidence !== undefined ? "SET n.evidence = $evidence" : ""}
     ${input.provenance.confidence !== undefined ? "SET n.confidence = $confidence" : ""}`,
    {
      id, name: input.name, description: input.description, trigger: input.trigger, steps,
      scope: input.scope, mode: input.mode, governs: JSON.stringify(valid),
      actor: input.provenance.actor, ts: new Date().toISOString(),
      source_quote: input.source_quote ?? null, repo: input.repo ?? null,
      evidence: input.provenance.evidence ?? null, confidence: input.provenance.confidence ?? null,
    },
  );

  await embedNode(input.graph, id);
  await record({ graph: input.graph, actor: input.provenance.actor, verb: "propose_procedure", input: { id, name: input.name, mode: input.mode, scope: input.scope, governs: valid }, status: "proposed" });
  return {
    status: "proposed",
    id,
    governs_pending: valid,
    governs_missing: missing,
    hint: "Awaiting human review in the dashboard inbox. Tell the user what you proposed so they can confirm or edit it.",
  };
}

// Agents can nominate a blessed procedure for retirement when a discussion
// reveals it no longer holds ("we don't do that anymore"). The nomination
// NEVER removes the procedure — it stays in circulation, marked
// retire_proposed, until a human confirms (review_procedure confirm_retire)
// or dismisses (dismiss_retire). Deletion remains human-only.
const proposeRetireProcedureInput = {
  id: z.string().min(1).describe("Procedure node id to nominate for retirement"),
  reason: z.string().min(1).describe("Why this procedure no longer applies — be specific"),
  source_quote: z.string().optional().describe("What the human said that invalidated it, verbatim"),
  provenance: z.object(provenanceShape),
  graph: z.string().default(DEFAULT_GRAPH),
};

async function proposeRetireProcedure(input: z.infer<z.ZodObject<typeof proposeRetireProcedureInput>>) {
  const rows = await run(
    input.graph,
    `MATCH (n {id: $id}) RETURN labels(n)[0] AS type, n.status AS status`,
    { id: input.id },
  );
  if (rows.length === 0) return { status: "error", error: `No node with id '${input.id}'` };
  if (rows[0].type !== "Procedure") return { status: "error", error: `'${input.id}' is a ${rows[0].type}, not a Procedure` };
  if (rows[0].status === "proposed") {
    return { status: "error", error: "This procedure is still a pending proposal — the user can simply reject it in the Inbox." };
  }
  if (rows[0].status === "retire_proposed") {
    return { status: "already_proposed", id: input.id, hint: "Retirement is already awaiting human review." };
  }
  await run(
    input.graph,
    `MATCH (n {id: $id})
     SET n.status = 'retire_proposed', n.retire_reason = $reason, n.retire_proposed_by = $actor, n.retire_proposed_at = $ts
     ${input.source_quote !== undefined ? ", n.retire_quote = $quote" : ""}`,
    { id: input.id, reason: input.reason, actor: input.provenance.actor, ts: new Date().toISOString(), quote: input.source_quote ?? null },
  );
  await record({ graph: input.graph, actor: input.provenance.actor, verb: "propose_retire_procedure", input: { id: input.id, reason: input.reason }, status: "retire_proposed" });
  return {
    status: "retire_proposed",
    id: input.id,
    hint: "The procedure STAYS ACTIVE until a human confirms the retirement in the dashboard. Tell the user what you nominated and why.",
  };
}

const reviewProcedureInput = {
  id: z.string().min(1).describe("Procedure node id, e.g. 'proc:run-migrations-before-deploy'"),
  action: z.enum(["approve", "reject", "confirm_retire", "dismiss_retire"]),
  edits: z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      trigger: z.string().min(1).optional(),
      steps: z.array(z.string().min(1)).min(1).optional(),
      scope: z.enum(["repo", "project"]).optional(),
      mode: z.enum(["insert", "retrieve"]).optional(),
      governs: z.array(z.string()).optional(),
    })
    .optional()
    .describe("Reviewer edits applied on approve — what is blessed is exactly what was reviewed"),
  provenance: z.object(provenanceShape),
  graph: z.string().default(DEFAULT_GRAPH),
};

async function reviewProcedure(input: z.infer<z.ZodObject<typeof reviewProcedureInput>>) {
  const rows = await run(
    input.graph,
    `MATCH (n {id: $id}) RETURN labels(n)[0] AS type, n.governs_pending AS pending`,
    { id: input.id },
  );
  if (rows.length === 0) return { status: "error", error: `No node with id '${input.id}'` };
  if (rows[0].type !== "Procedure") return { status: "error", error: `'${input.id}' is a ${rows[0].type}, not a Procedure` };

  if (input.action === "reject" || input.action === "confirm_retire") {
    // The journal keeps the record; the graph drops the node so rejected
    // proposals / confirmed retirements never pollute retrieval.
    await run(input.graph, `MATCH (n {id: $id}) DETACH DELETE n`, { id: input.id });
    await record({ graph: input.graph, actor: input.provenance.actor, verb: "review_procedure", input: { id: input.id, action: input.action }, status: input.action === "reject" ? "rejected" : "retired" });
    return { status: input.action === "reject" ? "rejected" : "retired", id: input.id };
  }

  if (input.action === "dismiss_retire") {
    await run(
      input.graph,
      `MATCH (n {id: $id})
       SET n.status = 'blessed', n.retire_reason = '', n.retire_quote = '', n.retire_proposed_by = '', n.retire_proposed_at = '',
           n.updated_by = $actor, n.updated_at = $ts`,
      { id: input.id, actor: input.provenance.actor, ts: new Date().toISOString() },
    );
    await record({ graph: input.graph, actor: input.provenance.actor, verb: "review_procedure", input: { id: input.id, action: "dismiss_retire" }, status: "blessed" });
    return { status: "blessed", id: input.id, hint: "Retirement dismissed — the procedure stays in force." };
  }

  const e = input.edits ?? {};
  const steps = e.steps ? e.steps.join("\n") : undefined;
  await run(
    input.graph,
    `MATCH (n {id: $id})
     SET n.status = 'blessed', n.governs_pending = '', n.blessed_by = $actor, n.blessed_at = $ts, n.updated_by = $actor, n.updated_at = $ts
     ${e.name !== undefined ? ", n.name = $name" : ""}
     ${e.description !== undefined ? ", n.description = $description" : ""}
     ${e.trigger !== undefined ? ", n.trigger = $trigger" : ""}
     ${steps !== undefined ? ", n.steps = $steps" : ""}
     ${e.scope !== undefined ? ", n.scope = $scope" : ""}
     ${e.mode !== undefined ? ", n.mode = $mode" : ""}`,
    {
      id: input.id, actor: input.provenance.actor, ts: new Date().toISOString(),
      name: e.name ?? null, description: e.description ?? null, trigger: e.trigger ?? null,
      steps: steps ?? null, scope: e.scope ?? null, mode: e.mode ?? null,
    },
  );

  // Materialize GOVERNS edges now — approval is the moment the procedure
  // enters circulation. Targets: reviewer override, else what the proposer
  // staged in governs_pending (JSON array; comma-split fallback for any
  // pre-JSON rows). Nodes deleted since proposal drop out of the MATCH.
  let targets = e.governs;
  if (!targets) {
    const pendingRaw = String(rows[0].pending ?? "");
    try {
      targets = JSON.parse(pendingRaw) as string[];
    } catch {
      targets = pendingRaw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  let linked: string[] = [];
  if (targets.length > 0) {
    const linkedRows = await run(
      input.graph,
      `MATCH (a {id: $from}) MATCH (b) WHERE b.id IN $targets
       MERGE (a)-[r:GOVERNS]->(b) SET r.updated_by = $actor, r.updated_at = $ts
       RETURN b.id AS id`,
      { from: input.id, targets, actor: input.provenance.actor, ts: new Date().toISOString() },
    );
    linked = linkedRows.map((r) => String(r.id));
  }

  await embedNode(input.graph, input.id);
  await record({ graph: input.graph, actor: input.provenance.actor, verb: "review_procedure", input: { id: input.id, action: "approve", edited: Object.keys(e), governs: linked }, status: "blessed" });
  return { status: "blessed", id: input.id, governs_linked: linked };
}

// ---------------------------------------------------------------------------
// correct_graph — a coding agent flags graph content that looks wrong or
// unclear. ADVISORY, never a write: the flag is journaled and forwarded to the
// orchestrator, which verifies it against the repo's registered base-branch
// checkout (never the flagging agent's working copy — that checkout is the
// ground truth that filters out branch-local and plain-wrong flags) and only
// then applies a correction through the normal indexer path.

const correctGraphInput = {
  target_ids: z.array(z.string().min(1)).min(1).max(10).describe("Node ids that look wrong or unclear"),
  reason: z.string().min(1).describe("What looks wrong — be specific about the field/edge and why"),
  evidence: z.string().optional().describe("file:line or other evidence that triggered the flag"),
  repo: z.string().optional().describe("Repository name whose base branch can verify this"),
  provenance: z.object(provenanceShape),
  graph: z.string().default(DEFAULT_GRAPH),
};

async function correctGraph(input: z.infer<z.ZodObject<typeof correctGraphInput>>) {
  const { found, missing } = await partitionByExistence(input.graph, input.target_ids);
  if (found.length === 0) {
    return { status: "error", error: `None of the target ids exist: ${missing.join(", ")}. Check ids with find_entity first.` };
  }

  // One evidence expression everywhere — the journal and the corrections
  // queue must agree on what was filed.
  const evidence = input.evidence ?? input.provenance.evidence ?? null;

  await record({
    graph: input.graph, actor: input.provenance.actor, verb: "correct_graph",
    input: { target_ids: found, reason: input.reason, evidence, repo: input.repo },
    status: "flagged",
  });

  // "Journaled but not queued" — the flag is never lost, but nothing will
  // verify it. All three failure paths share this shape.
  const recorded = (hint: string) => ({ status: "recorded", dispatched: false, missing_targets: missing, hint: `Flag journaled; ${hint}` });

  // Forward to the orchestrator's corrections queue. Env is injected by the
  // ACP runtime for agent sessions; the standalone HTTP gateway can point
  // FLOW_CORRECTIONS_URL (or ORCHESTRATOR_URL) at its project's orchestrator.
  // `||` not `??`: the runtime injects empty-string tokens when unset, and an
  // empty string must fall through to the next candidate.
  const url =
    process.env.FLOW_CORRECTIONS_URL ||
    (process.env.ORCHESTRATOR_URL ? `${process.env.ORCHESTRATOR_URL.replace(/\/$/, "")}/v1/corrections` : "");
  const token = process.env.FLOW_ACTIVITY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  if (!url) {
    return recorded("no orchestrator configured to verify it (FLOW_CORRECTIONS_URL unset).");
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        target_ids: found,
        reason: input.reason,
        evidence,
        repo: input.repo ?? null,
        actor: input.provenance.actor,
        session: process.env.FLOW_AGENT_SESSION ?? null,
        graph: input.graph,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string };
    if (!res.ok) {
      return recorded(`orchestrator dispatch failed (${res.status}).`);
    }
    return {
      status: body.status === "duplicate" ? "duplicate" : "accepted",
      correction_id: body.id,
      missing_targets: missing,
      hint: "The indexer will verify this against the repo's base branch and apply or reject it. You can move on.",
    };
  } catch (err) {
    return recorded(`orchestrator dispatch failed (${err instanceof Error ? err.message : String(err)}).`);
  }
}

// ---------------------------------------------------------------------------
// note — ungated branch-scoped working memory ("memory must not need
// maintaining"). The note never touches the graph here: it lands in the
// orchestrator's branch_notes store, scoped to (repo, branch), surfaced by
// injection into sessions on that branch, and promoted to the graph only
// after the base branch is reindexed. {repo, branch} are EXPLICIT args —
// Flow may run remotely (EC2) and never assumes the agent's filesystem;
// for Flow-run sessions the runtime injects defaults via env.

// ---------------------------------------------------------------------------
// search_knowledge — retrieve-only access to Flow's memory (distilled session
// memories + slack/linear corpus). Thin proxy to the orchestrator, which owns
// the store, the embeddings, and the eval-calibrated ranking (family hard gate,
// silence gate, FTS exact-match bypass). Search it like you grep: symptoms,
// identifiers, and file paths are the reliable path.

const SEARCH_MEMORY_MAX_BATCH = 10;

const searchMemoryInput = {
  // Single query OR a batch: pass `queries` to look up several things in one
  // call. At least one form is required; `query` wins when both are given.
  query: z.string().min(1).optional().describe("What to look up (single form). Works best with symptoms (verbatim error snippets), identifiers, command names, or file paths — like grep."),
  queries: z.array(z.string().min(1)).min(1).max(SEARCH_MEMORY_MAX_BATCH).optional().describe(`Several things to look up in one call (batch form, ≤${SEARCH_MEMORY_MAX_BATCH}) — prefer one batched call over sequential single searches. Results come back grouped per query.`),
  repo: z.string().optional().describe("Repository name for ranking (defaults from the session's env). Same-repo memories rank first, same-family next — but every memory in the project stays eligible; nothing is filtered out by repo."),
  limit: z.number().int().min(1).max(50).optional().describe("Max memories to return per query (default 8)."),
};

async function searchMemory(input: z.infer<z.ZodObject<typeof searchMemoryInput>>) {
  if (input.query === undefined && input.queries === undefined) {
    return { status: "error", error: "Pass `query` (single) or `queries` (batch, up to 10)." };
  }
  const repo = input.repo || process.env.FLOW_REPO || "";
  const url =
    process.env.FLOW_MEMORY_URL ||
    (process.env.ORCHESTRATOR_URL ? `${process.env.ORCHESTRATOR_URL.replace(/\/$/, "")}/v1/memory/search` : "");
  const token = process.env.FLOW_ACTIVITY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  if (!url) return { status: "error", error: "No orchestrator configured for memory search (FLOW_MEMORY_URL unset)." };
  // Proxy whichever form the caller sent — the orchestrator owns the batch
  // fan-out, grouping, and ranking. `query` wins if both are present.
  const payload =
    input.query !== undefined
      ? { query: input.query, repo: repo || null, limit: input.limit }
      : { queries: input.queries, repo: repo || null, limit: input.limit };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
    const body = (await res.json().catch(() => ({}))) as { lines?: string; error?: string };
    if (!res.ok) return { status: "error", error: `Memory search failed (${res.status}): ${body.error ?? ""}` };
    return { status: "ok", results: body.lines ?? "(no memories match)" };
  } catch (err) {
    return { status: "error", error: `Memory search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------

const noteInput = {
  text: z.string().min(1).describe("The note — a discovery, dead end, constraint, decision, or worry, written for whoever works on this branch next"),
  kind: z.enum(["wip", "note", "caution", "decision"]).default("note").describe("'wip' = rolling state of current work (replaces your previous wip note); others accumulate and get promoted to the graph on merge"),
  anchor_hint: z.string().optional().describe("Name or id of the entity this is about, if any — resolved at promotion time"),
  repo: z.string().optional().describe("Repository name (defaults from the session's env when Flow runs the session)"),
  branch: z.string().optional().describe("Branch name (defaults from the session's env)"),
  provenance: z.object(provenanceShape),
};

async function noteVerb(input: z.infer<z.ZodObject<typeof noteInput>>) {
  const repo = input.repo || process.env.FLOW_REPO || "";
  const branch = input.branch || process.env.FLOW_BRANCH || "";
  if (!repo || !branch) {
    return { status: "error", error: "repo and branch are required (no session defaults available here) — pass them explicitly." };
  }
  const url =
    process.env.FLOW_NOTES_URL ||
    (process.env.ORCHESTRATOR_URL ? `${process.env.ORCHESTRATOR_URL.replace(/\/$/, "")}/v1/notes` : "");
  const token = process.env.FLOW_ACTIVITY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  if (!url) return { status: "error", error: "No orchestrator configured for notes (FLOW_NOTES_URL unset)." };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        repo,
        branch,
        kind: input.kind,
        text: input.text,
        anchor_hint: input.anchor_hint ?? null,
        actor: input.provenance.actor,
        session: process.env.FLOW_AGENT_SESSION ?? null,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok) return { status: "error", error: `Notes dispatch failed (${res.status}): ${body.error ?? ""}` };
    return { status: "noted", id: body.id, hint: "Saved to this branch's working memory. It will surface for future sessions on this branch." };
  } catch (err) {
    return { status: "error", error: `Notes dispatch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// orient — the front desk. One call returns a compact, always-current
// orientation text: what this repo is, learned rules to follow (insert-mode
// procedures), on-demand procedures, and this branch's notes. It is the
// CLAUDE.md replacement: nothing is authored or synced to agent machines; the
// text is rendered fresh from the graph + note store on every call, so an
// agent can re-orient at any time (e.g. after context compaction).
//
// Size is fixed by construction: one line per entry, ORIENT_CAP entries per
// section, overflow shown as an explicit count — the store can grow without
// the front page growing.

const ORIENT_CAP = 5;

const oneLine = (s: unknown, max = 220): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const orientInput = {
  repo: z.string().optional().describe("Repository name (defaults from the session's env when Flow runs the session — pass explicitly otherwise)"),
  branch: z.string().optional().describe("Branch name (defaults from the session's env — pass explicitly otherwise)"),
  graph: z.string().default(DEFAULT_GRAPH),
};

interface OrientNote {
  id: string;
  kind: string;
  text: string;
}

async function fetchBranchNotes(repo: string, branch: string): Promise<OrientNote[] | null> {
  const url =
    process.env.FLOW_NOTES_URL ||
    (process.env.ORCHESTRATOR_URL ? `${process.env.ORCHESTRATOR_URL.replace(/\/$/, "")}/v1/notes` : "");
  if (!url || !repo || !branch) return null;
  const token = process.env.FLOW_ACTIVITY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  try {
    const res = await fetch(`${url}?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}&limit=50`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { rows?: OrientNote[] };
    return body.rows ?? [];
  } catch {
    return null;
  }
}

interface MemoryStats {
  memories: number;
  observations: number;
  bySource: Record<string, number>;
}

async function fetchMemoryStats(): Promise<MemoryStats | null> {
  const url =
    process.env.FLOW_MEMORY_URL?.replace(/\/search$/, "/stats") ||
    (process.env.ORCHESTRATOR_URL ? `${process.env.ORCHESTRATOR_URL.replace(/\/$/, "")}/v1/memory/stats` : "");
  if (!url) return null;
  const token = process.env.FLOW_ACTIVITY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  try {
    const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return (await res.json()) as MemoryStats;
  } catch {
    return null;
  }
}

interface OrientProc {
  id: string;
  name: string;
  trigger: string;
  mode: string;
  scope: string;
  repo: string | null;
}

async function orient(input: z.infer<z.ZodObject<typeof orientInput>>) {
  const repo = input.repo || process.env.FLOW_REPO || "";
  const branch = input.branch || process.env.FLOW_BRANCH || "";

  const [repoRows, counts, procRows, notes, memStats] = await Promise.all([
    run(input.graph, `MATCH (r:Repository) RETURN r.id AS id, r.name AS name, r.description AS description`),
    run(input.graph, `MATCH (n) RETURN labels(n)[0] AS type, count(*) AS count ORDER BY count DESC`),
    run(
      input.graph,
      `MATCH (p:Procedure) WHERE coalesce(p.status, '') <> 'proposed'
       RETURN p.id AS id, p.name AS name, p.trigger AS trigger,
              coalesce(p.mode, 'retrieve') AS mode, coalesce(p.scope, 'project') AS scope, p.repo AS repo
       ORDER BY p.created_at DESC`,
    ) as Promise<unknown> as Promise<OrientProc[]>,
    fetchBranchNotes(repo, branch),
    fetchMemoryStats(),
  ]);

  // Repo identity: match by name when the caller told us which repo; otherwise
  // whatever the graph holds (single-repo projects). Missing node ≠ error —
  // the graph may simply not be indexed yet.
  const repoRow =
    (repoRows as Array<{ id: string; name: string; description: string }>).find((r) => r.name === repo) ??
    (repoRows as Array<{ id: string; name: string; description: string }>)[0];

  // Procedures scoped to another repo are someone else's rules.
  const relevant = procRows.filter((p) => p.scope === "project" || !p.repo || !repo || p.repo === repo);
  const behavior = relevant.filter((p) => p.mode === "insert");
  const onDemand = relevant.filter((p) => p.mode !== "insert");

  const procLine = (p: OrientProc) => `- ${oneLine(p.name, 120)} — trigger: ${oneLine(p.trigger, 140)} [${p.id}]`;
  const section = <T>(items: T[], render: (item: T) => string, more: string): string[] => {
    const lines = items.slice(0, ORIENT_CAP).map(render);
    if (items.length > ORIENT_CAP) lines.push(`…${items.length - ORIENT_CAP} more — ${more}`);
    return lines;
  };

  const countMap = new Map((counts as Array<{ type: string; count: number }>).map((c) => [c.type, c.count]));
  const total = [...countMap.values()].reduce((a, b) => a + b, 0);
  const MAP_LABELS: Array<[type: string, singular: string, plural: string]> = [
    ["Service", "service", "services"],
    ["APIEndpoint", "API endpoint", "API endpoints"],
    ["Workflow", "workflow", "workflows"],
    ["UsageContract", "usage contract", "usage contracts"],
    ["Capability", "capability", "capabilities"],
  ];
  const mapBits = MAP_LABELS.filter(([t]) => countMap.has(t)).map(
    ([t, one, many]) => `${countMap.get(t)} ${countMap.get(t) === 1 ? one : many}`,
  );
  // Most-connected services are the best entry points into the graph.
  const serviceIds = await run(
    input.graph,
    `MATCH (s:Service) OPTIONAL MATCH (s)-[r]-() RETURN s.id AS id, count(r) AS deg ORDER BY deg DESC LIMIT 6`,
  );

  const out: string[] = [];
  out.push(`[flow orient — repo "${repo || "(unspecified)"}"${branch ? ` @ ${branch}` : ""}]`);
  out.push("");
  out.push("BEHAVIOR (learned project rules — follow these):");
  out.push(...(behavior.length ? section(behavior, procLine, "find_entity type 'Procedure'") : ["(nothing learned yet)"]));
  out.push("");
  if (repoRow) {
    out.push(`WHAT THIS IS: ${oneLine(repoRow.description, 500)} [${repoRow.id}]`);
  } else {
    out.push(`WHAT THIS IS: (repo "${repo}" not indexed in the graph yet)`);
  }
  out.push("");
  out.push(
    `MAP: ${total} nodes indexed${mapBits.length ? ` — ${mapBits.join(", ")}` : ""}.` +
      ((serviceIds as Array<{ id: string }>).length
        ? ` Start from ${(serviceIds as Array<{ id: string }>).map((s) => `[${s.id}]`).join(", ")}.`
        : ""),
  );
  out.push("");
  out.push(`PROCEDURES${onDemand.length ? ` (${onDemand.length})` : ""}:`);
  out.push(...(onDemand.length ? section(onDemand, procLine, "find_entity type 'Procedure'") : ["(none yet)"]));
  out.push("");
  out.push(`THIS BRANCH${notes && notes.length ? ` (${notes.length} ${notes.length === 1 ? "note" : "notes"})` : ""}:`);
  if (notes === null) {
    out.push(repo && branch ? "(notes unavailable right now)" : "(pass repo + branch to see this branch's notes)");
  } else if (notes.length === 0) {
    out.push("(no notes yet)");
  } else {
    out.push(...section(notes, (n) => `- [${n.kind}] ${oneLine(n.text, 260)}`, "they continue in this branch's note store"));
  }
  out.push("");
  // MEMORY — cross-session distilled knowledge + corpus, reached via
  // search_knowledge (retrieve-only). Counts orient the agent to whether it's
  // worth a look; the one-liner tells it how to query.
  if (memStats && (memStats.memories > 0 || memStats.observations > 0)) {
    const srcBits = Object.entries(memStats.bySource)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${n} ${s}`)
      .join(", ");
    out.push(
      `MEMORY: ${memStats.memories} distilled ${memStats.memories === 1 ? "memory" : "memories"}` +
        (srcBits ? ` from ${srcBits} observations` : "") +
        `. Search it like you grep — symptoms, identifiers, file paths work best (search_knowledge). ` +
        `get_entity on a node also shows a headline index of the memories/tickets/threads anchored to it. ` +
        `Drill into any [mem:…]/[obs:…]/[lin:…] with get_entity (batch ids[] works). ` +
        `Scope a search to a node with search_knowledge node:<node_id> (composes with type:memory|ticket|thread).`,
    );
  } else {
    out.push(
      "MEMORY: none yet — it fills as sessions end. Query with search_knowledge (symptoms, identifiers, file paths work best); " +
        "get_entity shows a per-node headline index once memories anchor to nodes.",
    );
  }
  out.push("");
  out.push(
    "HOW TO USE: search by INTENT with find_entity — describe what the code does ('list git branches of a repo') and results come back with file:line anchors, often faster than grepping for words you have to guess. " +
      "Drill into any [id] with get_entity BEFORE acting when your task touches an API endpoint, another service's behavior, or anything a contract or procedure might govern — contracts and rules hang off nodes, not files. Traverse with read_query. " +
      "Re-orient when entering an unfamiliar area, when a failure surprises you, or after context compaction. " +
      "Store back as you work: note (branch findings, free, no approval), propose_procedure (durable rules — when the user states one, draft it completely), correct_graph (when the graph contradicts the code).",
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------

const listSchemaInput = {};

async function listSchema() {
  return { nodeTypes: NODE_TYPES, edgeTypes: EDGE_TYPES };
}

// ---------------------------------------------------------------------------

export const verbs = {
  orient: {
    description:
      "Call this FIRST, before anything else, at the start of every session — and again after context compaction or when you feel lost. Returns your bearings in one page: learned project rules to follow, what this repo is, a map of the knowledge graph, procedures, and this branch's notes. Pass {repo, branch} explicitly when Flow doesn't run your session.",
    shape: orientInput,
    handler: orient,
  },
  find_entity: {
    description:
      "Look up graph entities by id, name, alias — or by INTENT: describe what the code does ('list git branches of a repo') and semantic search returns the matching nodes with their file:line anchors. Use this to find where behavior lives before grepping. Always check here before creating. Relevant distilled memories are blended in as `memory_hits` (typed terse lines, capped at 3 unless the query says type:memory). BATCH: pass qs:[…] (up to 10) to look up several phrases at once — results come back grouped per query, in order; prefer one batched call over sequential single searches.",
    shape: findEntityInput,
    handler: findEntity,
  },
  upsert_entity: {
    description: "Create or update a node. Requires provenance. Warns about similar existing nodes before creating.",
    shape: upsertEntityInput,
    handler: upsertEntity,
  },
  upsert_relation: {
    description: "Create or update a typed edge between two existing nodes. Requires provenance.",
    shape: upsertRelationInput,
    handler: upsertRelation,
  },
  get_entity: {
    description:
      "Fetch a node with all its incoming and outgoing relationships, plus a headline INDEX of the memories/tickets/threads anchored to it (headlines only, ~300 tokens; a '+N more' line is a working search_knowledge node:<id> query). Also resolves memory drill-down ids — mem:<id> (memory card: strength breakdown, anchors, evidence), obs:<id>, lin:<identifier>, slackthread:<ts>. BATCH: pass ids:[…] (up to 15) to fetch several nodes/cards in one call — sections come back in request order, one per id, with an explicit not-found entry for any missing id; prefer one batched call over sequential single lookups.",
    shape: getEntityInput,
    handler: getEntity,
  },
  read_query: {
    description: "Escape hatch: run read-only Cypher for traversals the other verbs don't cover.",
    shape: readQueryInput,
    handler: readQuery,
  },
  merge_entities: {
    description: "Merge a duplicate/placeholder node into a canonical one: rewires all edges, merges props and aliases, deletes the duplicate. Requires provenance.",
    shape: mergeEntitiesInput,
    handler: mergeEntities,
  },
  list_schema: {
    description: "List the node and edge types the gateway accepts.",
    shape: listSchemaInput,
    handler: listSchema,
  },
  propose_procedure: {
    description:
      "Propose a Procedure — a durable 'when you do X, do Y' rule a human stated. Draft it COMPLETELY (you hold the context): trigger, steps, scope, mode. It lands as a pending proposal for human review; show the user what you proposed. Use for general rules, NOT branch-/task-local instructions.",
    shape: proposeProcedureInput,
    handler: proposeProcedure,
  },
  review_procedure: {
    description:
      "Human review surface. approve (with optional edits) blesses a proposal; reject deletes it; confirm_retire deletes a retire-nominated procedure; dismiss_retire restores it to blessed.",
    shape: reviewProcedureInput,
    handler: reviewProcedure,
  },
  propose_retire_procedure: {
    description:
      "Nominate a blessed procedure for retirement when the user indicates it no longer applies ('we don't do that anymore'). The procedure STAYS ACTIVE until a human confirms in the dashboard — tell the user what you nominated and why.",
    shape: proposeRetireProcedureInput,
    handler: proposeRetireProcedure,
  },
  correct_graph: {
    description:
      "Flag graph content that looks wrong or unclear (stale description, missing/incorrect relationship). Advisory: the indexer verifies your flag against the repo's base branch and applies or rejects it — you do not edit the graph. Include the node ids, what's wrong, and file:line evidence.",
    shape: correctGraphInput,
    handler: correctGraph,
  },
  note: {
    description:
      "Save a branch-scoped working note — discoveries, dead ends ('tried X, deadlocked'), constraints, decisions, or current WIP state (kind 'wip' replaces your previous wip note). Free to use, no approval needed; it surfaces automatically for future sessions on this branch. Note things the next session would otherwise re-learn the hard way.",
    shape: noteInput,
    handler: noteVerb,
  },
  search_knowledge: {
    description:
      "Search Flow's cross-session memory (distilled decisions, constraints, gotchas, how-tos, preferences) plus the slack/linear corpus. Retrieve-only. Search it like you grep — verbatim error snippets, identifiers, command names, and file paths work best. Call it when a failure surprises you or before making a decision that a past session may have already settled. Scope to a graph node with a `node:<node_id>` token (filters to items anchored to that node — this is what get_entity's '+N more' line runs); narrow by kind with `type:memory|ticket|thread`; both compose with keywords. BATCH: pass queries:[…] (up to 10) to search several things at once — results come back grouped per query, in order; prefer one batched call over sequential single searches.",
    shape: searchMemoryInput,
    handler: searchMemory,
  },
} as const;

export type VerbName = keyof typeof verbs;

export async function callVerb(name: string, rawInput: unknown): Promise<unknown> {
  const verb = verbs[name as VerbName];
  if (!verb) return { status: "error", error: `Unknown verb '${name}'` };
  const parsed = z.object(verb.shape as z.ZodRawShape).safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { status: "error", error: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  return verb.handler(parsed.data as never);
}

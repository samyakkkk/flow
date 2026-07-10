import { z } from "zod";
import { DEFAULT_GRAPH, run } from "./graph.js";
import { record } from "./journal.js";
import { EDGE_TYPES, NODE_TYPES, isEdgeType, isNodeType } from "./schema.js";
import { embedText, embeddingsEnabled, entityText } from "./embed.js";

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

// Proposed-but-unblessed procedures are invisible to normal retrieval — they
// only enter circulation once a human approves them. Label-scoped to Procedure:
// other node types may legitimately carry a status prop (cleanProps allows it)
// and must not vanish from search. Dedup paths opt back in (includeProposed)
// so a second agent proposing the same rule sees the pending one instead of
// creating a duplicate.
const HIDE_PROPOSED = `AND NOT (labels(n)[0] = 'Procedure' AND coalesce(n.status, '') = 'proposed')`;

async function findSimilar(graph: string, q: string, type?: string, limit = 10, includeProposed = false): Promise<EntityRow[]> {
  const typeFilter = type ? `AND labels(n)[0] = $type` : "";
  const rows = await run(
    graph,
    `MATCH (n) WHERE (toLower(n.id) CONTAINS $ql OR toLower(n.name) CONTAINS $ql OR toLower(coalesce(n.aliases, '')) CONTAINS $ql) ${typeFilter} ${includeProposed ? "" : HIDE_PROPOSED}
     RETURN labels(n)[0] AS type, n.id AS id, n.name AS name, n.description AS description
     LIMIT ${clampLimit(limit)}`,
    { ql: q.toLowerCase(), ...(type ? { type } : {}) },
  );
  return rows as unknown as EntityRow[];
}

// Semantic search: embed the query, then rank nodes by cosine distance to their
// stored embedding. This is what rescues queries whose words appear nowhere in
// the graph ("worktree" → the repo-checkout / agent-session nodes). Brute-force
// over nodes carrying an embedding — exact (no HNSW recall loss) and instant at
// the hundreds-to-thousands of nodes a project graph holds. Returns [] when
// embeddings are unconfigured or the query can't be embedded.
async function findByVector(graph: string, q: string, type: string | undefined, limit: number, includeProposed = false): Promise<ScoredRow[]> {
  const vec = await embedText(q);
  if (!vec) return [];
  const typeFilter = type ? `AND labels(n)[0] = $type` : "";
  const rows = await run(
    graph,
    `MATCH (n) WHERE n.embedding IS NOT NULL ${typeFilter} ${includeProposed ? "" : HIDE_PROPOSED}
     WITH n, vec.cosineDistance(n.embedding, vecf32($vec)) AS d
     WHERE d <= $maxDistance
     RETURN labels(n)[0] AS type, n.id AS id, n.name AS name, n.description AS description, d AS distance
     ORDER BY d ASC
     LIMIT ${clampLimit(limit)}`,
    { vec, maxDistance: VECTOR_MAX_DISTANCE, ...(type ? { type } : {}) },
  );
  return (rows as unknown as ScoredRow[]).map((r) => ({
    ...r,
    via: "vector",
    distance: typeof r.distance === "number" ? Math.round(r.distance * 1000) / 1000 : r.distance,
  }));
}

// ---------------------------------------------------------------------------

const findEntityInput = {
  q: z.string().min(1).describe("Name, id, or phrase to look up"),
  type: z.string().optional().describe("Optional node type filter, e.g. 'Service'"),
  limit: z.number().int().min(1).max(50).default(10),
  graph: z.string().default(DEFAULT_GRAPH),
};

async function findEntity(input: z.infer<z.ZodObject<typeof findEntityInput>>) {
  const exact = await run(
    input.graph,
    `MATCH (n {id: $q}) RETURN labels(n)[0] AS type, n.id AS id, n.name AS name, n.description AS description`,
    { q: input.q },
  );
  if (exact.length > 0) return { status: "exact", matches: exact };

  // Lexical substring first — it's a high-precision signal when the caller
  // already knows a name/id fragment. Then augment with semantic matches the
  // substring scan can't reach. Lexical hits keep their rank; vector hits fill
  // the remaining slots, deduped by id.
  const lexical: ScoredRow[] = (await findSimilar(input.graph, input.q, input.type, input.limit)).map(
    (r) => ({ ...r, via: "lexical" }),
  );
  const vector = embeddingsEnabled() ? await findByVector(input.graph, input.q, input.type, input.limit) : [];

  const seen = new Set(lexical.map((r) => String(r.id)));
  const matches: ScoredRow[] = [...lexical];
  for (const v of vector) {
    if (matches.length >= input.limit) break;
    if (seen.has(String(v.id))) continue;
    seen.add(String(v.id));
    matches.push(v);
  }
  return { status: matches.length > 0 ? "similar" : "none", matches };
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
  id: z.string().min(1),
  graph: z.string().default(DEFAULT_GRAPH),
};

async function getEntity(input: z.infer<z.ZodObject<typeof getEntityInput>>) {
  const node = await run(input.graph, `MATCH (n {id: $id}) RETURN labels(n)[0] AS type, properties(n) AS props`, { id: input.id });
  if (node.length === 0) return { status: "not_found" };
  const out = await run(
    input.graph,
    `MATCH ({id: $id})-[r]->(m) RETURN type(r) AS rel, labels(m)[0] AS type, m.id AS id, m.name AS name, properties(r) AS props`,
    { id: input.id },
  );
  const inc = await run(
    input.graph,
    `MATCH ({id: $id})<-[r]-(m) RETURN type(r) AS rel, labels(m)[0] AS type, m.id AS id, m.name AS name, properties(r) AS props`,
    { id: input.id },
  );
  return { status: "found", node: node[0], outgoing: out, incoming: inc };
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
  // (findByVector self-noops to [] when embeddings are unconfigured.)
  const [lexical, vector] = await Promise.all([
    findSimilar(input.graph, input.name, "Procedure", 5, true),
    findByVector(input.graph, `${input.name}\n${input.trigger}`, "Procedure", 5, true),
  ]);
  const candidates = [
    ...lexical,
    ...vector.filter((v) => !lexical.some((l) => l.id === v.id)),
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

const listSchemaInput = {};

async function listSchema() {
  return { nodeTypes: NODE_TYPES, edgeTypes: EDGE_TYPES };
}

// ---------------------------------------------------------------------------

export const verbs = {
  find_entity: {
    description: "Look up graph entities by id, name, or alias. Always check here before creating.",
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
    description: "Fetch one node with all its incoming and outgoing relationships.",
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

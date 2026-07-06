import { z } from "zod";
import { DEFAULT_GRAPH, run } from "./graph.js";
import { record } from "./journal.js";
import { EDGE_TYPES, NODE_TYPES, isEdgeType, isNodeType } from "./schema.js";

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

async function findSimilar(graph: string, q: string, type?: string, limit = 10): Promise<EntityRow[]> {
  const typeFilter = type ? `AND labels(n)[0] = $type` : "";
  const rows = await run(
    graph,
    `MATCH (n) WHERE (toLower(n.id) CONTAINS $ql OR toLower(n.name) CONTAINS $ql OR toLower(coalesce(n.aliases, '')) CONTAINS $ql) ${typeFilter}
     RETURN labels(n)[0] AS type, n.id AS id, n.name AS name, n.description AS description
     LIMIT ${Math.max(1, Math.min(50, Math.floor(limit)))}`,
    { ql: q.toLowerCase(), ...(type ? { type } : {}) },
  );
  return rows as unknown as EntityRow[];
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
  const similar = await findSimilar(input.graph, input.q, input.type, input.limit);
  return { status: similar.length > 0 ? "similar" : "none", matches: similar };
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
    candidates = (await findSimilar(input.graph, input.name, input.type, 5)).filter((c) => c.id !== input.id);
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

  await record({ graph: input.graph, actor: input.provenance.actor, verb: "upsert_entity", input: { type: input.type, id: input.id, name: input.name }, status });
  return { status, id: input.id };
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
     RETURN properties(a) AS keepProps, properties(b) AS removeProps`,
    { keep: input.keep, remove: input.remove },
  );
  const keepProps = nodes[0]?.keepProps as Record<string, unknown> | null;
  const removeProps = nodes[0]?.removeProps as Record<string, unknown> | null;
  if (!keepProps || !removeProps) {
    return { status: "error", error: `Missing nodes: ${[!keepProps && input.keep, !removeProps && input.remove].filter(Boolean).join(", ")}` };
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

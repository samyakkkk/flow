import { tool } from "@opencode-ai/plugin";

// OpenCode code-file tools for the memory graph. Copy or symlink this file
// into your workspace's .opencode/tools/ directory; tool names become
// graph_find, graph_upsert, graph_relate, graph_get, graph_read, graph_schema.
//
// These are deliberately thin: every call goes over HTTP to the graph-gateway
// so all writes share one validated write path and land in its journal with
// this session's identity attached. Set GRAPH_GATEWAY_URL to override the
// default http://127.0.0.1:7433.

const BASE = process.env.GRAPH_GATEWAY_URL ?? "http://127.0.0.1:7433";

async function verb(name: string, input: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BASE}/v1/verbs/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return JSON.stringify(await res.json(), null, 2);
}

function actor(context: { agent?: string; sessionID?: string }): string {
  return `opencode:${context.agent ?? "unknown"}:${context.sessionID ?? "unknown"}`;
}

export const find = tool({
  description:
    "Look up entities in the memory graph by name, id, or alias. ALWAYS check here before creating a node — the thing you found in the code may already be modeled under another name.",
  args: {
    q: tool.schema.string().describe("Name, id, or phrase, e.g. 'user service'"),
    type: tool.schema.string().optional().describe("Optional node type filter, e.g. 'Service'"),
  },
  async execute(args) {
    return verb("find_entity", args);
  },
});

export const upsert = tool({
  description:
    "Create or update a node in the memory graph. If the response is 'similar_exists', review the candidates: reuse an existing id if it is the same thing, or retry with confirm=true if genuinely new.",
  args: {
    type: tool.schema.string().describe("Node type, e.g. 'Service'. Use graph_schema to list allowed types."),
    id: tool.schema.string().describe("Stable id, convention '<kind>:<name>', e.g. 'svc:users'"),
    name: tool.schema.string(),
    description: tool.schema.string().optional().describe("One paragraph a new teammate could learn from — powers retrieval, always worth writing"),
    aliases: tool.schema.array(tool.schema.string()).optional().describe("Other names humans use for this"),
    props: tool.schema.record(tool.schema.string(), tool.schema.union([tool.schema.string(), tool.schema.number(), tool.schema.boolean()])).optional(),
    evidence: tool.schema.string().optional().describe("Where this claim comes from, e.g. 'api-acme apis/scrapes/scrapes-api.js:1044'"),
    confidence: tool.schema.enum(["high", "medium", "low"]).optional(),
    confirm: tool.schema.boolean().optional().describe("true = create even though similar candidates were reported"),
  },
  async execute(args, context) {
    const { evidence, confidence, ...rest } = args;
    return verb("upsert_entity", { ...rest, provenance: { actor: actor(context), evidence, confidence } });
  },
});

export const relate = tool({
  description: "Create or update a typed edge between two existing nodes in the memory graph.",
  args: {
    type: tool.schema.string().describe("Edge type, e.g. 'CALLS'. Use graph_schema to list allowed types."),
    from: tool.schema.string().describe("Source node id"),
    to: tool.schema.string().describe("Target node id"),
    props: tool.schema.record(tool.schema.string(), tool.schema.union([tool.schema.string(), tool.schema.number(), tool.schema.boolean()])).optional(),
    evidence: tool.schema.string().optional(),
    confidence: tool.schema.enum(["high", "medium", "low"]).optional(),
  },
  async execute(args, context) {
    const { evidence, confidence, ...rest } = args;
    return verb("upsert_relation", { ...rest, provenance: { actor: actor(context), evidence, confidence } });
  },
});

export const get = tool({
  description: "Fetch one memory-graph node with all its relationships.",
  args: {
    id: tool.schema.string().describe("Node id, e.g. 'svc:users'"),
  },
  async execute(args) {
    return verb("get_entity", args);
  },
});

export const read = tool({
  description: "Run read-only Cypher against the memory graph for traversals the other graph tools don't cover. Writes are rejected.",
  args: {
    cypher: tool.schema.string().describe("MATCH/RETURN query"),
  },
  async execute(args) {
    return verb("read_query", args);
  },
});

export const merge = tool({
  description:
    "Merge a duplicate or placeholder node into the canonical one (e.g. an ExternalService placeholder into the real Service after its repo is indexed). Rewires all edges onto the kept node, folds aliases, deletes the duplicate. Use only when certain both ids are the same real-world thing.",
  args: {
    keep: tool.schema.string().describe("id of the canonical node to keep"),
    remove: tool.schema.string().describe("id of the duplicate to merge away"),
    evidence: tool.schema.string().optional().describe("Why these are the same thing"),
  },
  async execute(args, context) {
    const { evidence, ...rest } = args;
    return verb("merge_entities", { ...rest, provenance: { actor: actor(context), evidence } });
  },
});

export const schema = tool({
  description: "List the node and edge types the memory graph accepts.",
  args: {},
  async execute() {
    return verb("list_schema", {});
  },
});

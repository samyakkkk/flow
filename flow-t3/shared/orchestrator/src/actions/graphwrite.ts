// graphwrite.ts — Write to the knowledge graph via graph-gateway verbs.
// Calls http://127.0.0.1:7433 (GATEWAY_URL). Every call is journaled by gateway.
//
// The gateway exposes verbs ONLY at POST /v1/verbs/<name> with the exact input
// shapes its Zod schemas enforce (see graph-gateway/src/verbs.ts). Provenance
// is a nested object; entity upserts require `name`.

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:7433";
const GRAPH_NAME = process.env.GRAPH_NAME ?? "acme-v1";

export interface GraphWriteOptions {
  actor: string;       // provenance: who is writing (e.g. "orchestrator:event:<id>")
  evidence?: string;   // source reference
  confidence?: "high" | "medium" | "low";
}

function provenance(opts: GraphWriteOptions) {
  return { actor: opts.actor, evidence: opts.evidence, confidence: opts.confidence };
}

export async function upsertNode(
  nodeType: string,
  nodeId: string,
  name: string,
  props: Record<string, string | number | boolean>,
  opts: GraphWriteOptions
): Promise<unknown> {
  return gatewayVerb("upsert_entity", {
    graph: GRAPH_NAME,
    type: nodeType,
    id: nodeId,
    name,
    props,
    provenance: provenance(opts),
  });
}

export async function relateNodes(
  fromId: string,
  edgeType: string,
  toId: string,
  props: Record<string, string | number | boolean>,
  opts: GraphWriteOptions
): Promise<unknown> {
  return gatewayVerb("upsert_relation", {
    graph: GRAPH_NAME,
    type: edgeType,
    from: fromId,
    to: toId,
    props,
    provenance: provenance(opts),
  });
}

export async function mergeEntities(
  keepId: string,
  removeId: string,
  opts: GraphWriteOptions
): Promise<unknown> {
  return gatewayVerb("merge_entities", {
    graph: GRAPH_NAME,
    keep: keepId,
    remove: removeId,
    provenance: provenance(opts),
  });
}

export async function findNodes(q: string, type?: string, limit = 10): Promise<unknown> {
  return gatewayVerb("find_entity", { graph: GRAPH_NAME, q, type, limit });
}

async function gatewayVerb(verb: string, body: unknown): Promise<unknown> {
  const token = process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  const response = await fetch(`${GATEWAY_URL}/v1/verbs/${verb}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gateway verb ${verb} failed: HTTP ${response.status} — ${text}`);
  }
  const result = (await response.json()) as { status?: string; error?: string };
  if (result.status === "error") {
    throw new Error(`Gateway verb ${verb} rejected: ${result.error}`);
  }
  return result;
}

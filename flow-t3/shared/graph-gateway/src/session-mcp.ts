import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callVerb, verbs } from "./verbs.js";
import { SESSION_VERBS } from "./session-verbs.js";

const FLOW_NODE_IDS_META_KEY = "flow/nodeIds";

function collectNodeIds(value: unknown, ids: Set<string>, depth = 0): void {
  if (ids.size >= 50 || depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectNodeIds(item, ids, depth + 1);
    return;
  }
  const id = (value as Record<string, unknown>).id;
  if (typeof id === "string" && id.length > 0 && id.length < 200) ids.add(id);
  for (const item of Object.values(value)) collectNodeIds(item, ids, depth + 1);
}

// One server per HTTP request: no mutable process.env or shared client context.
// The authenticated endpoint chooses the graph, never the calling agent.
export function createSessionMcp(context: { graph: string; actor: string }) {
  const server = new McpServer({ name: "flow-graph", version: "0.3.0" });
  for (const [name, verb] of Object.entries(verbs)) {
    if (!SESSION_VERBS.has(name)) continue;
    server.registerTool(name, {
      description: verb.description,
      inputSchema: verb.shape,
      annotations: {
        readOnlyHint: !["remember", "correct_graph"].includes(name),
        destructiveHint: false,
        openWorldHint: false,
      },
    }, async (args: unknown) => {
      const input = { ...(args as Record<string, unknown>) };
      if (input.graph !== undefined && input.graph !== context.graph) {
        return { isError: true, content: [{ type: "text" as const, text: "This connection cannot access another project's graph." }] };
      }
      input.graph = context.graph;
      if (name === "correct_graph") {
        input.provenance = { ...(input.provenance as object ?? {}), actor: context.actor };
      }
      const result = await callVerb(name, input);
      const isError = typeof result === "object" && result !== null && "status" in result && result.status === "error";
      const nodeIds = new Set<string>();
      if (name === "find_entity" && !isError) collectNodeIds(result, nodeIds);
      const response = {
        isError,
        content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
      };
      if (nodeIds.size === 0) return response;
      return { ...response, _meta: { [FLOW_NODE_IDS_META_KEY]: [...nodeIds] } };
    });
  }
  return server;
}

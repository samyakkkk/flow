import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callVerb, verbs } from "./verbs.js";
import { SESSION_VERBS } from "./session-verbs.js";

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
      return {
        isError,
        content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
      };
    });
  }
  return server;
}

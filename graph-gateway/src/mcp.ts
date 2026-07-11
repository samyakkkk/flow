import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { callVerb, verbs } from "./verbs.js";

// MCP face of the gateway (stdio). Same verbs, same validation, same journal —
// MCP is just a protocol adapter over the single write path.
//
// Two modes:
// - Full (default): all verbs, for Flow's own graph builders.
// - Session (GATEWAY_MCP_READONLY=1): query verbs plus the two governed
//   proposal verbs (propose_procedure, correct_graph). This is what gets
//   injected into coding-agent sessions — agents consult the brain and may
//   PROPOSE (a pending procedure awaiting human bless; a correction flag the
//   indexer verifies against the base branch), but never edit it directly.
//
// Agent-session observability: when FLOW_ACTIVITY_URL is set, every tool call
// is reported (fire-and-forget) so the dashboard can highlight the graph
// nodes an agent is reading, live. Never blocks or fails the tool call.

const READONLY = process.env.GATEWAY_MCP_READONLY === "1";
const SESSION_VERBS = new Set([
  "orient",
  "find_entity",
  "get_entity",
  "read_query",
  "list_schema",
  // Governed proposal surface — none of these mutate existing knowledge
  // directly; procedures enter, change, and leave only through human review.
  "propose_procedure",
  "propose_retire_procedure",
  "correct_graph",
  // Ungated branch-scoped working memory.
  "note",
]);

const ACTIVITY_URL = process.env.FLOW_ACTIVITY_URL ?? "";
const ACTIVITY_TOKEN = process.env.FLOW_ACTIVITY_TOKEN ?? "";
const AGENT_SESSION = process.env.FLOW_AGENT_SESSION ?? "";

// Collect graph node ids (display ids live in string `id` fields — e.g.
// "cap:forms.publicSubmit") from a verb result, bounded so a huge read_query
// can't produce a megabyte of highlights.
function collectNodeIds(value: unknown, out: Set<string>, depth = 0): void {
  if (out.size >= 50 || depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectNodeIds(v, out, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  const id = obj.id ?? (obj.properties as Record<string, unknown> | undefined)?.id;
  if (typeof id === "string" && id.length > 0 && id.length < 200) out.add(id);
  for (const v of Object.values(obj)) collectNodeIds(v, out, depth + 1);
}

function reportActivity(verb: string, args: unknown, result: unknown, ok: boolean): void {
  if (!ACTIVITY_URL) return;
  const nodeIds = new Set<string>();
  if (ok) collectNodeIds(result, nodeIds);
  const argsStr = JSON.stringify(args ?? {});
  fetch(ACTIVITY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ACTIVITY_TOKEN ? { authorization: `Bearer ${ACTIVITY_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      session: AGENT_SESSION,
      verb,
      args: argsStr.length > 2000 ? argsStr.slice(0, 2000) + "…" : argsStr,
      nodeIds: [...nodeIds],
      ok,
      ts: Date.now(),
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

const server = new McpServer({
  name: READONLY ? "flow-graph" : "graph-gateway",
  version: "0.2.0",
});

for (const [name, verb] of Object.entries(verbs)) {
  if (READONLY && !SESSION_VERBS.has(name)) continue;
  server.registerTool(
    name,
    { description: verb.description, inputSchema: verb.shape },
    async (args: unknown) => {
      try {
        const result = await callVerb(name, args);
        reportActivity(name, args, result, true);
        // String results (orient) are prose for the model — don't JSON-escape them.
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        reportActivity(name, args, null, false);
        throw e;
      }
    },
  );
}

// Exit when the parent agent goes away — otherwise finished sessions leave
// orphaned MCP processes accumulating on the machine.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

await server.connect(new StdioServerTransport());

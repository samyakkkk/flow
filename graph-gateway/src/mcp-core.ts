import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callVerb, verbs } from "./verbs.js";

// Shared MCP server construction — the single tool surface behind both faces
// of the gateway: the stdio process (mcp.ts, spawned per agent/indexer
// session) and the streamable-HTTP endpoint (server.ts POST /mcp, for remote
// clients authenticated with a PAT). Same verbs, same validation, same
// journal — MCP stays a protocol adapter over the single write path.
//
// Three modes:
// - Full: all verbs, for operators driving the gateway by hand.
// - Builder: the indexer surface — query verbs plus the three write verbs,
//   with server-side write-scope enforcement and actor stamping.
// - Session: query verbs plus correct_graph (a flag the indexer verifies
//   against the base branch) and remember (text into the distiller intake).
//   This is what coding-agent sessions and remote MCP clients get — agents
//   consult the brain and contribute back, but never edit it directly.

export type McpMode = "session" | "builder" | "full";

export const SESSION_VERBS = new Set([
  "orient",
  "find_entity",
  "get_entity",
  "read_query",
  "list_schema",
  // Advisory flag — the indexer verifies it against the base branch; agents
  // never mutate existing knowledge directly.
  "correct_graph",
  // Active capture: "remember this" → distiller intake (extraction and
  // placement happen server-side; the model never classifies).
  "remember",
  // Retrieve-only cross-session memory (distilled decisions/gotchas + corpus).
  "search_knowledge",
]);

// The graph-builder surface: exactly what the old .opencode/tools/graph.ts
// plugin exposed, now served over MCP so workspaces need no npm install.
export const BUILDER_VERBS = new Set([
  "find_entity",
  "get_entity",
  "read_query",
  "list_schema",
  "upsert_entity",
  "upsert_relation",
  "merge_entities",
]);

// Which args of each write verb carry node ids, for write-scope checks.
const WRITE_VERB_ID_FIELDS: Record<string, string[]> = {
  upsert_entity: ["id"],
  upsert_relation: ["from", "to"],
  merge_entities: ["keep", "remove"],
};

export interface ActivityTarget {
  url: string;
  token?: string;
  session?: string;
}

export interface BuildMcpOptions {
  mode: McpMode;
  // Correction-verification jobs run with a WRITE SCOPE: the flagged node
  // ids. Their prompt embeds agent-authored text, so writes outside the
  // flagged neighborhood are refused — the verifier verifies the flag; it
  // does not get to rewrite the graph at large. Enforced here (server-side)
  // so a session cannot bypass it by shedding a tool file.
  writeScope?: Set<string> | null;
  // Job identity stamped onto every write's provenance, overriding whatever
  // the model put there — the actor field is an audit trail, not a model
  // choice.
  actor?: string;
  // Agent-session observability: when set, every tool call is reported
  // (fire-and-forget) so the dashboard can highlight the graph nodes an
  // agent is reading, live. Never blocks or fails the tool call.
  activity?: ActivityTarget | null;
}

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

export function buildMcpServer(opts: BuildMcpOptions): McpServer {
  const { mode, actor = "", activity = null } = opts;
  const writeScope = opts.writeScope ?? null;

  function scopeViolation(ids: Array<string | undefined>): string | null {
    if (!writeScope) return null;
    const outside = ids.filter((id): id is string => !!id && !writeScope.has(id));
    if (outside.length === 0) return null;
    return JSON.stringify({
      status: "error",
      error: `This verification job may only write to the flagged node(s): ${[...writeScope].join(", ")}. Out of scope: ${outside.join(", ")}. If the real fix lies elsewhere, reject the flag and say so in your verdict summary.`,
    });
  }

  function reportActivity(verb: string, args: unknown, result: unknown, ok: boolean): void {
    if (!activity?.url) return;
    const nodeIds = new Set<string>();
    if (ok) collectNodeIds(result, nodeIds);
    const argsStr = JSON.stringify(args ?? {});
    fetch(activity.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(activity.token ? { authorization: `Bearer ${activity.token}` } : {}),
      },
      body: JSON.stringify({
        session: activity.session ?? "",
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
    name: mode === "session" ? "flow-graph" : mode === "builder" ? "flow-graph-builder" : "graph-gateway",
    version: "0.2.0",
  });

  const EXPOSED = mode === "session" ? SESSION_VERBS : mode === "builder" ? BUILDER_VERBS : null;

  for (const [name, verb] of Object.entries(verbs)) {
    if (EXPOSED && !EXPOSED.has(name)) continue;
    // Safety annotations matter operationally: codex asks permission for
    // un-annotated MCP tools, and in headless `codex exec` an unanswerable
    // permission request cancels the call. Graph writes are idempotent upserts
    // into Flow's own database; merge_entities deletes a node, so it alone is
    // flagged destructive.
    const isWrite = name in WRITE_VERB_ID_FIELDS;
    const annotations = isWrite
      ? { readOnlyHint: false, destructiveHint: name === "merge_entities", idempotentHint: true, openWorldHint: false }
      : { readOnlyHint: true, openWorldHint: false };
    server.registerTool(
      name,
      { description: verb.description, inputSchema: verb.shape, annotations },
      async (args: unknown) => {
        const idFields = WRITE_VERB_ID_FIELDS[name];
        if (mode === "builder" && idFields) {
          const input = (args ?? {}) as Record<string, unknown>;
          const violation = scopeViolation(idFields.map((f) => input[f] as string | undefined));
          if (violation) {
            reportActivity(name, args, null, false);
            return { content: [{ type: "text" as const, text: violation }] };
          }
          if (actor) {
            input.provenance = { ...((input.provenance as Record<string, unknown>) ?? {}), actor };
          }
        }
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

  return server;
}

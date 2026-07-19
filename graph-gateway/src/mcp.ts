import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callVerb, verbs } from "./verbs.js";

// MCP face of the gateway (stdio). Same verbs, same validation, same journal —
// MCP is just a protocol adapter over the single write path.
//
// Three modes:
// - Full (default): all verbs, for operators driving the gateway by hand.
// - Builder (GATEWAY_MCP_MODE=builder): the indexer surface — query verbs plus
//   the three write verbs, with server-side write-scope enforcement and actor
//   stamping from env. This is what opencode index/enrich/correct_graph jobs
//   get via the workspace opencode.json.
// - Session (GATEWAY_MCP_READONLY=1): query verbs plus correct_graph (a flag
//   the indexer verifies against the base branch) and remember (text into the
//   distiller intake). This is what gets injected into coding-agent sessions —
//   agents consult the brain and contribute back, but never edit it directly.
//
// Agent-session observability: when FLOW_ACTIVITY_URL is set, every tool call
// is reported (fire-and-forget) so the dashboard can highlight the graph
// nodes an agent is reading, live. Never blocks or fails the tool call.

const MODE: "session" | "builder" | "full" =
  process.env.GATEWAY_MCP_READONLY === "1"
    ? "session"
    : process.env.GATEWAY_MCP_MODE === "builder"
      ? "builder"
      : "full";
const SESSION_VERBS = new Set([
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
const BUILDER_VERBS = new Set([
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

// Correction-verification jobs run with a WRITE SCOPE: the flagged node ids
// (FLOW_WRITE_SCOPE, comma-separated). Their prompt embeds agent-authored
// text, so writes outside the flagged neighborhood are refused — the verifier
// verifies the flag; it does not get to rewrite the graph at large. Enforced
// here (server-side) so a session cannot bypass it by shedding a tool file.
const WRITE_SCOPE: Set<string> | null = process.env.FLOW_WRITE_SCOPE
  ? new Set(process.env.FLOW_WRITE_SCOPE.split(",").map((s) => s.trim()).filter(Boolean))
  : null;

// Job identity stamped onto every write's provenance, overriding whatever the
// model put there — the actor field is an audit trail, not a model choice.
const FLOW_ACTOR = process.env.FLOW_ACTOR ?? "";

function scopeViolation(ids: Array<string | undefined>): string | null {
  if (!WRITE_SCOPE) return null;
  const outside = ids.filter((id): id is string => !!id && !WRITE_SCOPE.has(id));
  if (outside.length === 0) return null;
  return JSON.stringify({
    status: "error",
    error: `This verification job may only write to the flagged node(s): ${[...WRITE_SCOPE].join(", ")}. Out of scope: ${outside.join(", ")}. If the real fix lies elsewhere, reject the flag and say so in your verdict summary.`,
  });
}

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
  name: MODE === "session" ? "flow-graph" : MODE === "builder" ? "flow-graph-builder" : "graph-gateway",
  version: "0.2.0",
});

const EXPOSED = MODE === "session" ? SESSION_VERBS : MODE === "builder" ? BUILDER_VERBS : null;

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
      if (MODE === "builder" && idFields) {
        const input = (args ?? {}) as Record<string, unknown>;
        const violation = scopeViolation(idFields.map((f) => input[f] as string | undefined));
        if (violation) {
          reportActivity(name, args, null, false);
          return { content: [{ type: "text" as const, text: violation }] };
        }
        if (FLOW_ACTOR) {
          input.provenance = { ...((input.provenance as Record<string, unknown>) ?? {}), actor: FLOW_ACTOR };
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

// notify — scoped progress-update tool (G10), builder mode only. Posts back to
// the orchestrator that spawned this job; destination (channel + thread_ts) is
// resolved server-side from the job row, so the model cannot choose where the
// message lands. Auth is the per-job HMAC token (FLOW_JOB_TOKEN), never the
// admin token. Budget (2 delivered, 3rd soft-rejected) is enforced server-side
// and the response is returned verbatim so pushback reaches the model.
if (MODE === "builder" && process.env.FLOW_JOB_ID) {
  const ORCH_URL = process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:7500";
  const JOB_TOKEN = process.env.FLOW_JOB_TOKEN ?? "";
  const JOB_ID = process.env.FLOW_JOB_ID;
  server.registerTool(
    "notify",
    {
      description:
        "Send a brief progress update or final summary back to the Slack thread that triggered this task. " +
        "Use sparingly: the first two calls are delivered; a third will be soft-rejected with an error " +
        "message (returned to you) — only push through if something materially changed. " +
        "Do not use this for every step; only for meaningful milestones.",
      inputSchema: {
        text: z
          .string()
          .describe("The update text to post. Keep it brief and actionable, e.g. 'Indexing complete — found 42 services'."),
      },
    },
    async ({ text }: { text: string }) => {
      const res = await fetch(`${ORCH_URL}/v1/notify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(JOB_TOKEN ? { authorization: `Bearer ${JOB_TOKEN}` } : {}),
        },
        body: JSON.stringify({ job_id: JOB_ID, text }),
      });
      return { content: [{ type: "text" as const, text: await res.text() }] };
    },
  );
}

// Exit when the parent agent goes away — otherwise finished sessions leave
// orphaned MCP processes accumulating on the machine.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

await server.connect(new StdioServerTransport());

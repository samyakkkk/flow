import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildMcpServer, type McpMode } from "./mcp-core.js";

// Stdio face of the gateway — env-configured, spawned per session/job.
// Tool surface and modes live in mcp-core.ts (shared with the HTTP /mcp
// endpoint in server.ts); this file only translates env → build options and
// adds the builder-job-only `notify` tool.
//
// - Full (default): all verbs, for operators driving the gateway by hand.
// - Builder (GATEWAY_MCP_MODE=builder): the indexer surface, with write-scope
//   enforcement (FLOW_WRITE_SCOPE) and actor stamping (FLOW_ACTOR) from env.
//   This is what opencode index/enrich/correct_graph jobs get via the
//   workspace opencode.json.
// - Session (GATEWAY_MCP_READONLY=1): the coding-agent session surface.
//
// Agent-session observability: when FLOW_ACTIVITY_URL is set, every tool call
// is reported (fire-and-forget) so the dashboard can highlight the graph
// nodes an agent is reading, live.

const MODE: McpMode =
  process.env.GATEWAY_MCP_READONLY === "1"
    ? "session"
    : process.env.GATEWAY_MCP_MODE === "builder"
      ? "builder"
      : "full";

const WRITE_SCOPE: Set<string> | null = process.env.FLOW_WRITE_SCOPE
  ? new Set(process.env.FLOW_WRITE_SCOPE.split(",").map((s) => s.trim()).filter(Boolean))
  : null;

const ACTIVITY_URL = process.env.FLOW_ACTIVITY_URL ?? "";

const server = buildMcpServer({
  mode: MODE,
  writeScope: WRITE_SCOPE,
  actor: process.env.FLOW_ACTOR ?? "",
  activity: ACTIVITY_URL
    ? {
        url: ACTIVITY_URL,
        token: process.env.FLOW_ACTIVITY_TOKEN ?? "",
        session: process.env.FLOW_AGENT_SESSION ?? "",
      }
    : null,
});

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

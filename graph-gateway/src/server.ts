import { createServer } from "node:http";
import { callVerb, verbs } from "./verbs.js";
import { record, tail } from "./journal.js";
import { DEFAULT_GRAPH, deletedGraphError, run } from "./graph.js";
import { runBootTasks } from "./reconcile.js";
import { startLocalModel } from "./local-embed.js";
import { embedText, embeddingsEnabled, EMBED_DIM } from "./embed.js";
import { isPat, verifyPatForProject } from "./patAuth.js";

// HTTP face of the gateway — bind to localhost only.
//   POST /v1/verbs/<name>   body: verb input JSON   (bearer-authed)
//   POST /v1/embed          body: { text }          (bearer-authed)
//   GET  /v1/journal?limit=50                        (bearer-authed)
//   GET  /health                                     (open)
//
// Auth: when GATEWAY_TOKEN or FLOW_ADMIN_TOKEN is in the env (flow up passes
// the project .env), every non-/health request must carry a bearer that is
// EITHER that static token (internal services: orchestrator, dashboard
// proxy, indexer) OR a personal access token from the deployment auth store
// (per-user machine credential, minted in the dashboard) whose user holds a
// grant on this gateway's project (FLOW_PROJECT_NAME). This closes the local
// self-bless hole (any process could call review_procedure) and is the
// per-user gating for remote MCP clients (EC2 topology). No token in env →
// open, as before — dev fallback only.

const port = Number(process.env.GATEWAY_PORT ?? 7433);
const TOKEN = process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
if (!TOKEN) {
  console.warn("[gateway] no GATEWAY_TOKEN/FLOW_ADMIN_TOKEN in env — HTTP verbs are UNAUTHENTICATED (dev mode)");
}

function authorized(header: string): boolean {
  if (!header.startsWith("Bearer ")) return false;
  const bearer = header.slice("Bearer ".length);
  if (isPat(bearer)) return verifyPatForProject(bearer) !== null;
  return bearer === TOKEN;
}

function json(res: import("node:http").ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, verbs: Object.keys(verbs) });
    }
    if (TOKEN) {
      const auth = String(req.headers.authorization ?? "");
      if (!authorized(auth)) {
        return json(res, 401, { status: "error", error: "Unauthorized — this gateway requires a bearer token (project token or a personal access token with a grant on this project)." });
      }
    }
    if (req.method === "GET" && url.pathname === "/v1/journal") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(res, 200, { entries: await tail(limit) });
    }
    // Shared embedding endpoint. The gateway is the single owner of the local
    // model, so other services (the orchestrator's branch-note store) embed
    // through this hop instead of loading a second copy of Gemma. `ready` lets
    // callers distinguish "model still downloading" from "embed failed" and
    // store text without a vector rather than blocking. `dim` is the model's
    // vector size so callers can guard against mixing embedding spaces.
    if (req.method === "POST" && url.pathname === "/v1/embed") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: { text?: unknown } = {};
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { status: "error", error: "Body must be valid JSON" });
        }
      }
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) return json(res, 400, { status: "error", error: "text is required" });
      const ready = embeddingsEnabled();
      const vec = ready ? await embedText(text) : null;
      return json(res, 200, { vec, dim: EMBED_DIM, ready });
    }
    // Admin-only entity deletion — deliberately NOT a verb, so no MCP mode
    // (session, builder, or full) can reach it; only bearer-authed services.
    // Used by the orchestrator's repo_removed cleanup to drop the Repository
    // node of a disconnected repo. DETACH DELETE, journaled like every write.
    if (req.method === "POST" && url.pathname === "/v1/admin/delete-entity") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: { graph?: string; id?: string; actor?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return json(res, 400, { status: "error", error: "Body must be valid JSON" });
      }
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return json(res, 400, { status: "error", error: "id is required" });
      const graph = typeof body.graph === "string" && body.graph.trim() ? body.graph.trim() : DEFAULT_GRAPH;
      // Even a MATCH auto-creates the graph in FalkorDB — don't resurrect a
      // tombstoned graph just to delete a node from it.
      if (await deletedGraphError(graph)) return json(res, 200, { status: "not_found", id });
      const found = await run(graph, `MATCH (n {id: $id}) RETURN n.id`, { id });
      if (found.length === 0) return json(res, 200, { status: "not_found", id });
      await run(graph, `MATCH (n {id: $id}) DETACH DELETE n`, { id });
      await record({
        graph,
        actor: body.actor ?? "admin",
        verb: "admin_delete_entity",
        input: { id },
        status: "deleted",
      });
      return json(res, 200, { status: "deleted", id });
    }
    const verbMatch = url.pathname.match(/^\/v1\/verbs\/([a-z_]+)$/);
    if (req.method === "POST" && verbMatch) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      let input: unknown = {};
      if (raw.trim()) {
        try {
          input = JSON.parse(raw);
        } catch {
          return json(res, 400, { status: "error", error: "Body must be valid JSON" });
        }
      }
      const result = await callVerb(verbMatch[1], input);
      const isError = typeof result === "object" && result !== null && (result as { status?: string }).status === "error";
      return json(res, isError ? 400 : 200, result);
    }
    return json(res, 404, { status: "error", error: "Not found" });
  } catch (err) {
    return json(res, 500, { status: "error", error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`graph-gateway listening on http://127.0.0.1:${port} (default graph: '${DEFAULT_GRAPH}')`);
  // Start the local embedding model download immediately so it runs in
  // parallel with migrations. runBootTasks awaits the same singleton promise
  // before it reconciles embeddings — nodes indexed during the download are
  // backfilled automatically once the model is ready. See reconcile.ts.
  startLocalModel();
  runBootTasks(DEFAULT_GRAPH);
});

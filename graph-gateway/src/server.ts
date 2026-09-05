import { createServer } from "node:http";
import { callVerb, verbs } from "./verbs.js";
import { record, tail } from "./journal.js";
import { DEFAULT_GRAPH, deletedGraphError, run } from "./graph.js";
import { reconcileEmbeddings, runBootTasks } from "./reconcile.js";
import { startLocalModel } from "./local-embed.js";
import { embedText, embeddingsEnabled } from "./embed.js";
import { activeEmbeddingDim, activeEmbeddingModel } from "./embedding-models.js";
import { isPat, verifyPatForProject } from "./patAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSessionMcp } from "./session-mcp.js";

// HTTP face of the gateway — bind to localhost only.
//   POST /v1/verbs/<name>   body: verb input JSON   (bearer-authed)
//   POST /v1/embed          body: { text }          (bearer-authed)
//   POST /v1/reconcile/embeddings                    (bearer-authed)
//   GET  /v1/journal?limit=50                        (bearer-authed)
//   GET  /health                                     (open)
//
// Auth: when GATEWAY_TOKEN or FLOW_ADMIN_TOKEN is in the env (flow up passes
// the project .env), every non-/health request must carry a bearer that is
// EITHER that static token (internal services: orchestrator, dashboard
// proxy, indexer) OR a personal access token from the deployment auth store
// (per-user machine credential, minted in the dashboard) whose user holds a
// grant on this gateway's project (FLOW_PROJECT_NAME). This closes the local
// unauthenticated-writes hole (any process could call the write verbs) and is the
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
    if (url.pathname === "/mcp") {
      // Remote access never inherits the legacy unauthenticated dev fallback.
      if (!TOKEN) return json(res, 503, { error: "MCP requires configured authentication" });
      const bearer = String(req.headers.authorization ?? "");
      if (!authorized(bearer)) return json(res, 401, { error: "Unauthorized" });
      const origin = req.headers.origin;
      const allowedOrigins = (process.env.FLOW_MCP_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
      if (origin && !allowedOrigins.includes(origin)) return json(res, 403, { error: "Origin not allowed" });
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return json(res, 405, { error: "Only POST is supported" });
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 1024 * 1024) return json(res, 413, { error: "Request too large" });
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return json(res, 400, { error: "Body must be valid JSON" }); }
      const token = bearer.slice("Bearer ".length);
      const actor = isPat(token) ? `user:${verifyPatForProject(token)}` : "project-service";
      const mcp = createSessionMcp({ graph: DEFAULT_GRAPH, actor });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
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
      return json(res, 200, { vec, dim: activeEmbeddingDim(), ready });
    }
    // Indexing writes arrive through short-lived MCP processes. A final
    // reconciliation closes the race where those writes happen while the
    // gateway's local model is still loading.
    if (req.method === "POST" && url.pathname === "/v1/reconcile/embeddings") {
      if (!embeddingsEnabled()) {
        return json(res, 503, { status: "error", error: "local embedding model not yet loaded" });
      }
      const result = await reconcileEmbeddings(DEFAULT_GRAPH);
      return json(res, 200, { status: "ok", graph: DEFAULT_GRAPH, ...result });
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
  const model = activeEmbeddingModel();
  console.log(`graph-gateway listening on http://127.0.0.1:${port} (default graph: '${DEFAULT_GRAPH}', embed model: ${model.id}, dim: ${model.dim})`);
  // Start the local embedding model download immediately so it runs in
  // parallel with migrations — but only when the local model is the active
  // provider. An API model has nothing to download. runBootTasks awaits the
  // same singleton promise before it reconciles embeddings — nodes indexed
  // during the download are backfilled once the model is ready. See reconcile.ts.
  if (model.provider === "local") startLocalModel();
  runBootTasks(DEFAULT_GRAPH);
});

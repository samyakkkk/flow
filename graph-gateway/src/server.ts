import { createServer } from "node:http";
import { callVerb, verbs } from "./verbs.js";
import { tail } from "./journal.js";
import { DEFAULT_GRAPH } from "./graph.js";
import { runBootTasks } from "./reconcile.js";

// HTTP face of the gateway. No auth in v1 — bind to localhost only.
//   POST /v1/verbs/<name>   body: verb input JSON
//   GET  /v1/journal?limit=50
//   GET  /health

const port = Number(process.env.GATEWAY_PORT ?? 7433);

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
    if (req.method === "GET" && url.pathname === "/v1/journal") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(res, 200, { entries: await tail(limit) });
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
  // Converge this graph in the background: versioned migrations, then
  // reconcilers (e.g. embedding backfill). See reconcile.ts.
  runBootTasks(DEFAULT_GRAPH);
});

import { NextRequest } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { requireProject } from "@/lib/projectContext";

export const runtime = "nodejs";

// POST /<project>/mcp → that project's gateway streamable-HTTP MCP endpoint.
// proxy.ts already authenticated the caller (PAT in prod, nothing in local)
// and stamped the project header. In prod the bearer is forwarded as-is —
// the gateway re-verifies the PAT against the auth store, so revocation cuts
// access within its cache TTL even mid-session. In local mode the project
// admin token is injected server-side, making the URL usable with zero
// client config (`claude mcp add --transport http flow
// http://localhost:7600/<project>/mcp`).
export async function POST(req: NextRequest): Promise<Response> {
  const project = await requireProject();
  const headers = new Headers();
  headers.set("content-type", req.headers.get("content-type") ?? "application/json");
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  const auth = req.headers.get("authorization");
  if (!IS_LOCAL && auth) {
    headers.set("authorization", auth);
  } else {
    headers.set("authorization", `Bearer ${project.adminToken}`);
  }

  // MCP request bodies are small JSON-RPC messages — buffer rather than
  // stream to keep the upstream fetch simple. The response may be SSE and is
  // streamed straight through.
  const body = await req.arrayBuffer();
  const upstream = await fetch(`${project.gatewayUrl}/mcp`, {
    method: "POST",
    headers,
    body,
    signal: req.signal,
    cache: "no-store",
  });

  const respHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) respHeaders.set("content-type", ct);
  respHeaders.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

// Stateless endpoint — no SSE resume stream, no session to delete.
function methodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Stateless MCP endpoint — POST only." }, id: null },
    { status: 405, headers: { allow: "POST" } }
  );
}
export function GET(): Response {
  return methodNotAllowed();
}
export function DELETE(): Response {
  return methodNotAllowed();
}

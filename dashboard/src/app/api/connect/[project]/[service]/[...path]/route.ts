// Outbound knowledge/capture transport only. Never inject dashboard/admin auth.
import { NextRequest, NextResponse } from "next/server";
import { getRegistryProject } from "@/lib/registry";
const allowed: Record<string, Set<string>> = {
  gateway: new Set(["v1/connection", "mcp", "v1/verbs/orient"]),
  orchestrator: new Set(["v1/connection", "v1/ingest/hook", "v1/ingest/opencode", "v1/memory/search", "v1/memory/remember", "v1/telemetry/track"]),
};
async function forward(req: NextRequest, context: { params: Promise<{ project: string; service: string; path: string[] }> }) {
  const p = await context.params, route = p.path.join("/");
  const project = getRegistryProject(p.project);
  if (!project || !allowed[p.service]?.has(route)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer flowpat_[a-f0-9]{8}_[a-f0-9]{32}$/.test(auth)) return NextResponse.json({ error: "Personal credential required" }, { status: 401 });
  const body = req.method === "GET" ? undefined : await req.arrayBuffer();
  if (body && body.byteLength > 2 * 1024 * 1024) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const headers = new Headers({ authorization: auth, "content-type": "application/json", accept: req.headers.get("accept") ?? "application/json" });
  for (const name of ["mcp-protocol-version", "mcp-session-id"]) { const v = req.headers.get(name); if (v) headers.set(name, v); }
  try {
    const res = await fetch(`${p.service === "gateway" ? project.gatewayUrl : project.orchestratorUrl}/${route}`, { method: req.method, headers, body, redirect: "error", signal: AbortSignal.timeout(30_000) });
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  } catch { return NextResponse.json({ error: "Flow service unavailable" }, { status: 502 }); }
}
export const GET = forward;
export const POST = forward;

import { NextRequest } from "next/server";
import { requireProject } from "@/lib/projectContext";

export const runtime = "nodejs";

// /<project>/v1/* → the project's gateway or orchestrator, server-side.
// This is the machine surface for coding agents on a REMOTE deployment: the
// flow-mcp wrapper's verb/embed calls, the flow-hook shim's transcript
// ingest, and the CLI agent's memory search/remember all hit these paths.
// proxy.ts already authenticated the caller (PAT bearer in prod, nothing in
// local) and stamped the project header; here we pick the upstream by the
// first path segment and inject the project's admin token — the dashboard is
// the auth boundary, so the raw gateway/orchestrator ports stay private.
//
// Gateway owns the graph verbs + embeddings; the orchestrator owns memory,
// ingest, corrections, activity, and work-folder registration.
const GATEWAY_SEGMENTS = new Set(["verbs", "embed", "journal", "reconcile"]);

async function forward(req: NextRequest, path: string[]): Promise<Response> {
  const project = await requireProject();
  const seg0 = path[0] ?? "";
  const base = GATEWAY_SEGMENTS.has(seg0) ? project.gatewayUrl : project.orchestratorUrl;
  const upstream = `${base}/v1/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;

  const headers = new Headers();
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  headers.set("authorization", `Bearer ${project.adminToken}`);
  // Forward the proxy-verified caller identity so the orchestrator can attribute
  // captured sessions to the right user (ingest anti-forgery). proxy.ts stamped
  // this (stripping any client value); the raw ports are private, so it's trusted.
  const patUser = req.headers.get("x-flow-pat-user");
  if (patUser) headers.set("x-flow-pat-user", patUser);

  const method = req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();
  const res = await fetch(upstream, { method, headers, body, signal: req.signal, cache: "no-store" });

  const respHeaders = new Headers();
  const rct = res.headers.get("content-type");
  if (rct) respHeaders.set("content-type", rct);
  respHeaders.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, headers: respHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  return forward(req, (await params).path);
}
export async function POST(req: NextRequest, { params }: Ctx) {
  return forward(req, (await params).path);
}
export async function PUT(req: NextRequest, { params }: Ctx) {
  return forward(req, (await params).path);
}

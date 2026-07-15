import { NextRequest } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { requireProject } from "@/lib/projectContext";

// GET /api/agents/sessions/:id/events — SSE pass-through from the orchestrator.
// The browser's EventSource can't send Authorization headers, so the token is
// attached server-side here and the body is streamed straight through.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const token = await getSessionToken();
  if (!token) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const since = req.nextUrl.searchParams.get("since") ?? "0";

  const project = await requireProject();
  const upstream = await fetch(
    `${project.orchestratorUrl}/v1/agents/sessions/${encodeURIComponent(id)}/events?since=${since}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: req.signal,
      cache: "no-store",
    }
  );
  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream ${upstream.status}`, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

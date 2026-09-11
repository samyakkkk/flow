import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/memory/list — proxy the orchestrator's Knowledge Base listing
// (memories with attribution + paged corpus). Query string passes through
// verbatim: ?q=&source=&limit=&offset=.

export async function GET(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  try {
    const res = await orcFetch(`/v1/memory/list${url.search}`, token);
    if (!res.ok) return NextResponse.json({ error: `Orchestrator ${res.status}` }, { status: 502 });
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Orchestrator unreachable" }, { status: 502 });
  }
}

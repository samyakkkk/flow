import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/corrections — proxy the orchestrator's corrections queue (agent
// flags being verified against base-branch checkouts) for the Knowledge Base
// page's corrections section.

export async function GET(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    const res = await orcFetch(`/v1/corrections${qs}`, token);
    if (!res.ok) return NextResponse.json({ error: `Orchestrator ${res.status}`, rows: [] }, { status: 502 });
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Orchestrator unreachable", rows: [] }, { status: 502 });
  }
}

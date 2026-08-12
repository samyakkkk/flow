import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents/sessions/search?q=… — proxy to the orchestrator's semantic
// session search.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "q required" }, { status: 400 });
  const limit = req.nextUrl.searchParams.get("limit");
  try {
    const path = `/v1/agents/sessions/search?q=${encodeURIComponent(q)}${limit ? `&limit=${encodeURIComponent(limit)}` : ""}`;
    const res = await orcFetch(path, token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents/options?backend= — what the backend advertises (model
// selector, thought toggles, modes) before any session exists. Probed via a
// scratch ACP session in the orchestrator, cached per backend.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const backend = req.nextUrl.searchParams.get("backend") ?? "";
  try {
    const res = await orcFetch(`/v1/agents/options?backend=${encodeURIComponent(backend)}`, token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

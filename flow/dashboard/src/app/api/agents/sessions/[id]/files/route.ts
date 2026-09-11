import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents/sessions/:id/files?q= — @mention file/folder autocomplete
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  try {
    const res = await orcFetch(
      `/v1/agents/sessions/${encodeURIComponent(id)}/files?q=${encodeURIComponent(q)}`,
      token
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents/sessions/:id/diff — git diff of the agent's checkout.
// Forwards ?scope=session|base through to the orchestrator.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const scope = new URL(req.url).searchParams.get("scope");
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  try {
    const res = await orcFetch(`/v1/agents/sessions/${encodeURIComponent(id)}/diff${qs}`, token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

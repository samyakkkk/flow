import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

const ACTIONS = new Set(["prompt", "cancel", "permission", "mode", "config"]);

// POST /api/agents/sessions/:id/(prompt|cancel|permission|mode)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> }
): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, action } = await params;
  if (!ACTIONS.has(action)) return NextResponse.json({ error: "Unknown action" }, { status: 404 });
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* cancel has no body */
  }
  try {
    const res = await orcFetch(
      `/v1/agents/sessions/${encodeURIComponent(id)}/${action}`,
      token,
      { method: "POST", body: JSON.stringify(body ?? {}) }
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

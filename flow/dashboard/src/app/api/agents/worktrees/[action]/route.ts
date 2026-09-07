import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// Proxy the separate-copy exits:
//   GET  /api/agents/worktrees/diff?path=…        base-scope diff of a copy
//   POST /api/agents/worktrees/{remove|pr|open}     {path, ...}
// Status is passed through so the client sees the orchestrator's honest error
// bodies verbatim.
const POST_ACTIONS = new Set(["remove", "pr", "open", "apply", "push"]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ action: string }> }
): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { action } = await params;
  if (action !== "diff") return NextResponse.json({ error: "not found" }, { status: 404 });
  const path = new URL(req.url).searchParams.get("path") ?? "";
  try {
    const res = await orcFetch(`/v1/agents/worktrees/diff?path=${encodeURIComponent(path)}`, token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ action: string }> }
): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { action } = await params;
  if (!POST_ACTIONS.has(action)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await orcFetch(`/v1/agents/worktrees/${action}`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

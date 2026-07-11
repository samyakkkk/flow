import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents/worktrees — the flow-managed "separate copies" (optionally
// ?repo=<name>). Passes the orchestrator's status through unchanged.
export async function GET(req: Request): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const repo = new URL(req.url).searchParams.get("repo");
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  try {
    const res = await orcFetch(`/v1/agents/worktrees${qs}`, token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents/repos/files?repo=&q= — @mention autocomplete before a
// session exists (the "start a new session" composer).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const repo = req.nextUrl.searchParams.get("repo") ?? "";
  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (!repo) return NextResponse.json({ error: "repo required" }, { status: 400 });
  try {
    const res = await orcFetch(
      `/v1/agents/repos/files?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(q)}`,
      token
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

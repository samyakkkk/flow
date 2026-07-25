import { NextRequest, NextResponse } from "next/server";
import { currentUser, getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents/repos/files?repo=&q=&folder= — @mention autocomplete before
// a session exists (the "start a new session" composer). `folder` scopes the
// listing to one of the CURRENT USER's work folders (owner resolved
// server-side, same as /api/agents).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const repo = req.nextUrl.searchParams.get("repo") ?? "";
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const folder = req.nextUrl.searchParams.get("folder") ?? "";
  if (!repo) return NextResponse.json({ error: "repo required" }, { status: 400 });
  try {
    const user = await currentUser();
    const owner = user?.email ?? "local";
    const res = await orcFetch(
      `/v1/agents/repos/files?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(q)}` +
        (folder ? `&folder=${encodeURIComponent(folder)}&owner=${encodeURIComponent(owner)}` : ""),
      token
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/index-log?repo=<name>&limit=<n> — durable indexer lifecycle trail (proxied)
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const repo = req.nextUrl.searchParams.get("repo") ?? "";
  const limit = req.nextUrl.searchParams.get("limit") ?? "";
  const qs = new URLSearchParams();
  if (repo) qs.set("repo", repo);
  if (limit) qs.set("limit", limit);
  try {
    const res = await orcFetch(`/v1/index-log${qs.size ? `?${qs}` : ""}`, token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/index-activity?repo=<name> — live indexer activity (proxied)
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const repo = req.nextUrl.searchParams.get("repo") ?? "";
  try {
    const res = await orcFetch(`/v1/index-activity?repo=${encodeURIComponent(repo)}`, token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// POST /api/sources/inspect — classify a GitHub URL or local path.
// Thin authed passthrough to the orchestrator; the server owns classification.
export async function POST(req: Request): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.text();
    const res = await orcFetch("/v1/sources/inspect", token, { method: "POST", body });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

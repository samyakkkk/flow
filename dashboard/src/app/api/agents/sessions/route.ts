import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents/sessions — list; POST — create {backend, repo, prompt}
export async function GET(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const res = await orcFetch("/v1/agents/sessions", token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const res = await orcFetch("/v1/agents/sessions", token, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

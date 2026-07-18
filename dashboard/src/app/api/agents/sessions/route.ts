import { NextRequest, NextResponse } from "next/server";
import { currentUser, getSessionToken } from "@/lib/auth";
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
    const body = (await req.json()) as Record<string, unknown>;
    // Owner is resolved server-side so workFolder ownership checks can't be
    // spoofed from the client.
    const user = await currentUser();
    const res = await orcFetch("/v1/agents/sessions", token, {
      method: "POST",
      body: JSON.stringify({ ...body, owner: user?.email ?? "local" }),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

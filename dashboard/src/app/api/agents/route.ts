import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents — installed agents + connected repos (proxied to orchestrator)
export async function GET(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const res = await orcFetch("/v1/agents", token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

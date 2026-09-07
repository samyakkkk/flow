import { NextResponse } from "next/server";
import { currentUser, getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/agents — installed agents + connected repos + the CURRENT USER's
// work folders (owner resolved server-side; folders are never shared).
export async function GET(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const user = await currentUser();
    const owner = user?.email ?? "local";
    const res = await orcFetch(`/v1/agents?owner=${encodeURIComponent(owner)}`, token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

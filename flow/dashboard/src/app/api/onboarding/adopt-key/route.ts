import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// POST /api/onboarding/adopt-key — reuse the machine's saved OpenRouter key for
// this project (copies it into the project's settings).
export async function POST(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const res = await orcFetch("/v1/onboarding/adopt-key", token, { method: "POST", body: "{}" });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}

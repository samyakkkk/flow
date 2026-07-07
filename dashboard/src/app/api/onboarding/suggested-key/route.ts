import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/onboarding/suggested-key — does the machine have an OpenRouter key
// saved from another project that this one can reuse? Returns { available, hint }.
export async function GET(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ available: false }, { status: 401 });
  try {
    const res = await orcFetch("/v1/onboarding/suggested-key", token);
    return NextResponse.json(await res.json(), { status: res.ok ? 200 : res.status });
  } catch {
    return NextResponse.json({ available: false });
  }
}

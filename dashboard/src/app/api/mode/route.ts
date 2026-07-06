import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcGet } from "@/lib/orchestrator";

interface ModeResponse {
  mode: "local" | "prod";
  gates: { slack: string };
}

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const data = await orcGet<ModeResponse>("/v1/mode", token);
    return NextResponse.json(data);
  } catch {
    // Fallback: if orchestrator is unreachable, assume local
    return NextResponse.json({ mode: "local", gates: { slack: "prod_only" } });
  }
}

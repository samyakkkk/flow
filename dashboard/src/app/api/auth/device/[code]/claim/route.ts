import { NextRequest, NextResponse } from "next/server";
import { claimDeviceToken } from "@/lib/deviceFlow";

// POST /api/auth/device/<code>/claim — the CLI's poll. The code (32 random
// hex, 10-min TTL) is the bearer of this handshake; once approved, the first
// claim gets the token and deletes the entry.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const result = claimDeviceToken(code);
  if (!result) return NextResponse.json({ error: "Unknown or expired connect code" }, { status: 404 });
  return NextResponse.json(result);
}

import { NextRequest, NextResponse } from "next/server";
import { getDeviceRequest } from "@/lib/deviceFlow";

// GET /api/auth/device/<code> — status + machine label for the /connect
// approval page. Never returns the token: the CLI gets that from /claim,
// so a browser polling this can't consume the CLI's one-shot handoff.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const req = getDeviceRequest(code);
  if (!req) return NextResponse.json({ error: "Unknown or expired connect code" }, { status: 404 });
  return NextResponse.json({ status: req.token ? "approved" : "pending", label: req.label });
}

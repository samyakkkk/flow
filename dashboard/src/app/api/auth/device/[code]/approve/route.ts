import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";
import { loadAuthStore, saveAuthStore, mintPat } from "@/lib/authStore";
import { getDeviceRequest, approveDeviceRequest } from "@/lib/deviceFlow";

// POST /api/auth/device/<code>/approve — the logged-in user's click on the
// /connect page. Mints a PAT for THAT user (label = the machine's hostname)
// and parks it for the CLI to claim. The token inherits the user's project
// grants like any PAT, and shows up in their token list for revocation.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (IS_LOCAL) return NextResponse.json({ error: "Not available in local mode" }, { status: 400 });
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { code } = await params;
  const req = getDeviceRequest(code);
  if (!req) return NextResponse.json({ error: "Unknown or expired connect code" }, { status: 404 });
  if (req.token) return NextResponse.json({ error: "Already approved" }, { status: 409 });

  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  const { token, record } = mintPat(user.id, req.label);
  store.tokens.push(record);
  saveAuthStore(store);
  approveDeviceRequest(code, token);
  return NextResponse.json({ ok: true, label: req.label });
}

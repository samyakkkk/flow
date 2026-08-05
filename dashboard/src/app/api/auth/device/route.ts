import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { createDeviceRequest } from "@/lib/deviceFlow";

// POST /api/auth/device {label} — start a `flow connect` handshake.
// Unauthenticated (it's the CLI, pre-auth): returns an opaque single-use
// code the CLI embeds in the /connect?code=… URL it opens for the user.
// The store is capped and entries expire in 10 minutes (deviceFlow.ts).
export async function POST(req: NextRequest) {
  if (IS_LOCAL) {
    return NextResponse.json(
      { error: "Local deployments need no connect — the dashboard and CLI already share the machine." },
      { status: 400 }
    );
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "unnamed machine";
  // Optional machine-pairing secret (48 hex chars) — see AuthToken.pairing.
  const pairing =
    typeof body.pairing === "string" && /^[0-9a-f]{48}$/.test(body.pairing) ? body.pairing : undefined;
  const code = createDeviceRequest(label, pairing);
  if (!code) {
    return NextResponse.json({ error: "Too many pending connect attempts — try again in a few minutes." }, { status: 429 });
  }
  return NextResponse.json({ code });
}

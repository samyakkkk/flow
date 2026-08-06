import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { loadAuthStore, saveAuthStore, mintPat } from "@/lib/authStore";
import { consumePreblessed } from "@/lib/deviceFlow";

// POST /api/auth/device/<code>/complete {label, pairing, local_url}
// The CLI end of the one-command install: a pre-blessed code (minted by the
// logged-in dashboard, see prebless) is exchanged for a PAT, using the
// machine details the CLI supplies now. Unauthenticated by design — the code
// IS the bearer of this handshake and is single-use + 10-min TTL. No browser
// approval step (the user already approved by generating the command while
// logged in).
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (IS_LOCAL) return NextResponse.json({ error: "Not available in local mode" }, { status: 400 });
  const { code } = await params;

  const consumed = consumePreblessed(code);
  if (!consumed) {
    return NextResponse.json({ error: "Unknown, expired, or already-used connect code" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "unnamed machine";
  const pairing = typeof body.pairing === "string" && /^[0-9a-f]{48}$/.test(body.pairing) ? body.pairing : undefined;
  const localUrl =
    typeof body.local_url === "string" && /^http:\/\/localhost:\d{2,5}$/.test(body.local_url) ? body.local_url : undefined;

  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  // The pre-blessed user may have been deleted between minting and completing.
  if (!store.users.some((u) => u.id === consumed.userId)) {
    return NextResponse.json({ error: "The approving account no longer exists" }, { status: 409 });
  }

  const { token, record } = mintPat(consumed.userId, label);
  if (pairing) record.pairing = pairing;
  if (localUrl) record.localUrl = localUrl;
  store.tokens.push(record);
  saveAuthStore(store);

  return NextResponse.json({ token });
}

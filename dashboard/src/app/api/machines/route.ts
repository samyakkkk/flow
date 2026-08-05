import { NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";
import { loadAuthStore } from "@/lib/authStore";

// GET /api/machines — the signed-in user's connected machines (PATs minted
// via `flow connect` that carry a pairing secret). The pairing secret lets a
// page served by THIS deployment call the machine's LOCAL Flow cross-origin —
// the browser is sitting on one of these machines; the page tries each
// pairing against localhost and only that machine's door answers. Pairing
// grants nothing on this server, and only the minting user ever sees it.
export async function GET() {
  if (IS_LOCAL) return NextResponse.json({ machines: [] });
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  return NextResponse.json({
    machines: store.tokens
      .filter((t) => t.userId === user.id && t.pairing)
      .map((t) => ({ id: t.id, label: t.label, pairing: t.pairing, createdAt: t.createdAt })),
  });
}

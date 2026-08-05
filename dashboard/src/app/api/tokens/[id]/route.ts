import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";
import { loadAuthStore, saveAuthStore, verifyPat } from "@/lib/authStore";

// DELETE /api/tokens/<id> — revoke one of YOUR tokens (owners may revoke
// anyone's). Takes effect on the gateway within its store-cache TTL (~2s).
// A PAT may also revoke ITSELF (the bearer's id must match the target id) —
// that's `flow remotes remove` cleaning up server-side without a browser
// session. A PAT can never revoke any other token.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (IS_LOCAL) {
    return NextResponse.json({ error: "Personal tokens are a prod-mode feature" }, { status: 400 });
  }
  const { id } = await params;

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (bearer && bearer.startsWith(`flowpat_${id}_`) && verifyPat(bearer)) {
    const store = loadAuthStore();
    if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
    store.tokens = store.tokens.filter((t) => t.id !== id);
    saveAuthStore(store);
    return NextResponse.json({ ok: true });
  }

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  const token = store.tokens.find((t) => t.id === id);
  if (!token) return NextResponse.json({ error: "No such token" }, { status: 404 });
  if (token.userId !== user.id && user.role !== "owner") {
    return NextResponse.json({ error: "Not your token" }, { status: 403 });
  }

  store.tokens = store.tokens.filter((t) => t.id !== id);
  saveAuthStore(store);
  return NextResponse.json({ ok: true });
}

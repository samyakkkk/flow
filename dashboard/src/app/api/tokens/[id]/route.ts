import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";
import { loadAuthStore, saveAuthStore } from "@/lib/authStore";

// DELETE /api/tokens/<id> — revoke one of YOUR tokens (owners may revoke
// anyone's). Takes effect on the gateway within its store-cache TTL (~2s).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (IS_LOCAL) {
    return NextResponse.json({ error: "Personal tokens are a prod-mode feature" }, { status: 400 });
  }
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

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

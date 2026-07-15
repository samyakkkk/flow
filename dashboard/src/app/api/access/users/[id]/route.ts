import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { requireOwner } from "@/lib/auth";
import { loadAuthStore, saveAuthStore, hashPassword } from "@/lib/authStore";

// PUT    /api/access/users/<id>  {grants?, role?, password?} — update a user
// DELETE /api/access/users/<id>                              — remove a user
// Prod, owner only. Removing or demoting the LAST owner is refused — a
// deployment with no owner can never manage access again.

type Params = { params: Promise<{ id: string }> };

async function ownerGuard() {
  if (IS_LOCAL) {
    return { error: NextResponse.json({ error: "Access management is a prod-mode feature" }, { status: 400 }) };
  }
  const owner = await requireOwner();
  if (!owner) return { error: NextResponse.json({ error: "Owner access required" }, { status: 403 }) };
  return { owner };
}

export async function PUT(req: NextRequest, { params }: Params) {
  const g = await ownerGuard();
  if (g.error) return g.error;
  const { id } = await params;

  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  const user = store.users.find((u) => u.id === id);
  if (!user) return NextResponse.json({ error: "No such user" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (body.role === "member" || body.role === "owner") {
    const owners = store.users.filter((u) => u.role === "owner");
    if (user.role === "owner" && body.role === "member" && owners.length === 1) {
      return NextResponse.json({ error: "Cannot demote the last owner" }, { status: 409 });
    }
    user.role = body.role;
  }
  if (Array.isArray(body.grants)) {
    if (user.role === "owner") {
      delete store.grants[user.id]; // owners are implicitly granted everything
    } else {
      store.grants[user.id] = body.grants.filter((x): x is string => typeof x === "string");
    }
  }
  if (typeof body.password === "string" && body.password.length > 0) {
    if (body.password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    user.passwordHash = hashPassword(body.password);
  }

  saveAuthStore(store);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const g = await ownerGuard();
  if (g.error) return g.error;
  const { id } = await params;

  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  const user = store.users.find((u) => u.id === id);
  if (!user) return NextResponse.json({ error: "No such user" }, { status: 404 });
  if (user.role === "owner" && store.users.filter((u) => u.role === "owner").length === 1) {
    return NextResponse.json({ error: "Cannot remove the last owner" }, { status: 409 });
  }

  store.users = store.users.filter((u) => u.id !== id);
  delete store.grants[id];
  store.tokens = store.tokens.filter((t) => t.userId !== id); // their PATs die with them
  saveAuthStore(store);
  return NextResponse.json({ ok: true });
}

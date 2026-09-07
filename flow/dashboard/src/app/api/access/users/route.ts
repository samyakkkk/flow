import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { IS_LOCAL } from "@/lib/config";
import { requireOwner } from "@/lib/auth";
import { loadAuthStore, saveAuthStore, hashPassword } from "@/lib/authStore";

// Deployment-level access management (prod, owner only).
// GET  /api/access/users            → users + their grants
// POST /api/access/users            → create a user {email, password, grants}

function guard() {
  if (IS_LOCAL) {
    return NextResponse.json({ error: "Access management is a prod-mode feature" }, { status: 400 });
  }
  return null;
}

export async function GET() {
  const g = guard();
  if (g) return g;
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  return NextResponse.json({
    users: store.users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      grants: u.role === "owner" ? ["*"] : store.grants[u.id] ?? [],
    })),
  });
}

export async function POST(req: NextRequest) {
  const g = guard();
  if (g) return g;
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Owner access required" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const grants = Array.isArray(body.grants) ? body.grants.filter((x): x is string => typeof x === "string") : [];
  const role = body.role === "owner" ? "owner" : "member";

  if (!email || !/.+@.+\..+/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  if (store.users.some((u) => u.email === email)) {
    return NextResponse.json({ error: "A user with that email already exists" }, { status: 409 });
  }

  const user = {
    id: randomBytes(8).toString("hex"),
    email,
    role: role as "owner" | "member",
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  if (role !== "owner") store.grants[user.id] = grants;
  saveAuthStore(store);
  return NextResponse.json({ ok: true, id: user.id });
}

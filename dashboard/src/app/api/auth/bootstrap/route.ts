import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { IS_LOCAL, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/config";
import { loadAuthStore, saveAuthStore, hashPassword, mintSession } from "@/lib/authStore";

// POST /api/auth/bootstrap {setupToken, email, password} — create the FIRST
// owner account. Gated by the one-time setup code `flow up` printed, so an
// exposed box can't be claimed by whoever visits first. Disabled once any
// user exists.
export async function POST(req: NextRequest) {
  if (IS_LOCAL) return NextResponse.json({ error: "Not available in local mode" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const setupToken = typeof body.setupToken === "string" ? body.setupToken.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !/.+@.+\..+/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const store = loadAuthStore();
  if (!store) {
    return NextResponse.json(
      { error: "Auth store missing — run `flow up` on the server first." },
      { status: 503 }
    );
  }
  if (store.users.length > 0) {
    return NextResponse.json({ error: "Already set up — sign in instead." }, { status: 409 });
  }
  if (!store.setupToken || setupToken !== store.setupToken) {
    return NextResponse.json({ error: "Invalid setup code — it's printed by `flow up` on the server." }, { status: 401 });
  }

  const user = {
    id: randomBytes(8).toString("hex"),
    email,
    role: "owner" as const,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  delete store.setupToken; // one-shot
  saveAuthStore(store);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, mintSession(user.id, SESSION_MAX_AGE, store), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}

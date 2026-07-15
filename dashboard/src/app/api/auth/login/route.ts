import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/config";
import { loadAuthStore, verifyPassword, mintSession } from "@/lib/authStore";

// POST /api/auth/login {email, password} — prod-mode sign-in against the
// deployment auth store. One session covers every project the user is
// granted; per-project scoping happens in the proxy + requireSession().
export async function POST(req: NextRequest) {
  if (IS_LOCAL) return NextResponse.json({ ok: true }); // no login step on your own box

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const store = loadAuthStore();
  if (!store || store.users.length === 0) {
    return NextResponse.json(
      { error: "No accounts yet — create the owner account first." },
      { status: 409 }
    );
  }

  const user = store.users.find((u) => u.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, mintSession(user.id, SESSION_MAX_AGE, store), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}

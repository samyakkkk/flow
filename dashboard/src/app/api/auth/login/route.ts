import { NextRequest, NextResponse } from "next/server";
import { validateToken } from "@/lib/auth";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/config";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const token = (body.token as string | undefined)?.trim();

  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const valid = await validateToken(token);
  if (!valid) {
    return NextResponse.json({ error: "Invalid token or orchestrator unreachable" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
    // secure: true — enable in production with HTTPS
  });
  return res;
}

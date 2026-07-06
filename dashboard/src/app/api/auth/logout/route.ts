import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/config";

export async function POST() {
  const res = NextResponse.redirect(new URL("/login", process.env.NEXTAUTH_URL ?? "http://localhost:7600"));
  res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}

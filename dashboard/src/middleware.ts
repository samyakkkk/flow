import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/config";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/check",
  "/_next",
  "/favicon.ico",
];

function toLogin(req: NextRequest, clearCookie: boolean) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?from=${encodeURIComponent(req.nextUrl.pathname)}`;
  const res = NextResponse.redirect(url);
  if (clearCookie) res.cookies.delete(SESSION_COOKIE);
  return res;
}

// Central auth gate. A cookie that merely *exists* is not enough — a stale or
// expired token used to sail past and then 401 on every page (home wrongly
// showed the key gate, session pages broke). Here we validate the token for
// real, once, before any page renders.
//
// Multi-project safety: validation goes through THIS project's own
// `/api/auth/check` (Node runtime → this process's ORCHESTRATOR_URL), so a
// cookie is only ever accepted by the project it belongs to — even though all
// projects share one dashboard build. A valid cookie for project A is rejected
// by project B and bounced to that project's login.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return toLogin(req, false);

  // API routes forward the token to the orchestrator and enforce auth
  // themselves; don't double-validate (and don't add a round-trip to every
  // data call). Middleware guards the *page* navigations.
  if (pathname.startsWith("/api/")) return NextResponse.next();

  try {
    const check = await fetch(new URL("/api/auth/check", req.nextUrl.origin), {
      headers: { cookie: req.headers.get("cookie") ?? "" },
      cache: "no-store",
    });
    // Fail closed only on an explicit auth rejection. Fail OPEN on anything
    // else (orchestrator briefly down, network blip) so a transient hiccup
    // never logs everyone out mid-session.
    if (check.status === 401 || check.status === 403) {
      return toLogin(req, true);
    }
  } catch {
    // validator unreachable — let the request through; pages degrade gracefully
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

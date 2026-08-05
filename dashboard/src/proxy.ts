import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, IS_LOCAL, PROJECT_HEADER } from "@/lib/config";
import { listRegistryProjects, getRegistryProject, isValidProjectName } from "@/lib/registry";
import { verifySession, verifyPat, userCanAccess, userProjectFilter, loadAuthStore } from "@/lib/authStore";

// Central router + auth gate (Next 16 `proxy` file convention — Node runtime,
// so the project registry and auth store are plain fs reads, no round-trips).
//
// URL scheme (single dashboard for every project on the deployment):
//   /<name>/<rest>    → rewritten to /<rest> with the project name stamped
//                       into the PROJECT_HEADER request header. Pages and API
//                       routes resolve their project from that header.
//   /                 → redirect to the default project's home
//   /p/<name>/<rest>  → legacy prefix — permanent redirect to /<name>/<rest>
//   /login, /api/auth/*, /api/projects, /api/access/*, /api/tokens
//                     → deployment-level, no project scope (these names are
//                       refused as project names by the CLI and registry)
//
// Auth model:
//   local — single user on their own box; no login, full access. The
//           project admin tokens never leave the server either way.
//   prod  — signed session cookie for a user account in data/auth.json.
//           Grants are enforced HERE for pages (redirect to /login) and
//           re-checked in requireSession() for every API route. A project
//           that doesn't exist and a project the user isn't granted answer
//           identically (404) so neither names nor existence leak.
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/",
  "/_next",
  "/favicon.ico",
];

// Deployment-level API prefixes that carry no project scope but DO require a
// session in prod (enforced inside the routes themselves).
const DEPLOYMENT_API = ["/api/projects", "/api/access", "/api/tokens"];

function toLogin(req: NextRequest, clearCookie: boolean) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?from=${encodeURIComponent(req.nextUrl.pathname)}`;
  const res = NextResponse.redirect(url);
  if (clearCookie) res.cookies.delete(SESSION_COOKIE);
  return res;
}

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function toHome(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  return NextResponse.redirect(url);
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (DEPLOYMENT_API.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next(); // routes enforce their own session/role checks
  }

  // Legacy /p/<name>/… prefix → the bare form.
  const legacy = pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
  if (legacy) {
    const url = req.nextUrl.clone();
    url.pathname = `/${legacy[1]}${legacy[2] ?? "/"}`;
    return NextResponse.redirect(url, 308);
  }

  // Resolve the session user once (prod). Local mode needs no user.
  const user = IS_LOCAL ? null : verifySession(req.cookies.get(SESSION_COOKIE)?.value);

  // "/" → the default project: last-used (cookie) if still valid, else the
  // first project this user can see.
  if (pathname === "/") {
    if (!IS_LOCAL && !user) return toLogin(req, true);
    const projects = listRegistryProjects();
    const filter = !IS_LOCAL && user ? userProjectFilter(user, loadAuthStore()) : null;
    const visible = filter === null ? projects : projects.filter((p) => filter.includes(p.name));
    if (visible.length === 0) {
      // No projects (or none granted). Send prod users somewhere explicable.
      return IS_LOCAL
        ? NextResponse.next() // root page renders the "no projects yet" state
        : toLogin(req, false);
    }
    const last = req.cookies.get("flow_last_project")?.value;
    const target = visible.find((p) => p.name === last) ?? visible[0];
    const url = req.nextUrl.clone();
    url.pathname = `/${target.name}/`;
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Project-scoped URLs: /<name>/<rest>
  const m = pathname.match(/^\/([^/]+)(\/.*)?$/);
  const name = m?.[1] ?? "";
  const rest = m?.[2] || "/";
  const project = isValidProjectName(name) ? getRegistryProject(name) : null;
  const isApi = rest.startsWith("/api/") || (name === "api" && !project);

  // /<name>/mcp — remote MCP endpoint (streamable HTTP). MCP clients carry a
  // bearer PAT, not a session cookie, so the page/API auth below doesn't
  // apply. Leak discipline is preserved: a missing/invalid token answers 401
  // BEFORE the project is resolved (existence never leaks to bad creds); a
  // valid token without a grant answers 404, identical to a project that
  // doesn't exist. Local mode needs no token — single user on their own box.
  if (rest === "/mcp") {
    if (!IS_LOCAL) {
      const auth = req.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const patUser = bearer ? verifyPat(bearer) : null;
      if (!patUser) {
        return NextResponse.json(
          { error: "Unauthorized — pass a personal access token (dashboard → Tokens) as a bearer." },
          { status: 401 }
        );
      }
      if (!project || !userCanAccess(patUser, name)) return notFound();
    } else if (!project) {
      return notFound();
    }
    const mcpHeaders = new Headers(req.headers);
    mcpHeaders.set(PROJECT_HEADER, name);
    const mcpUrl = req.nextUrl.clone();
    mcpUrl.pathname = "/mcp";
    return NextResponse.rewrite(mcpUrl, { request: { headers: mcpHeaders } });
  }

  if (!project) {
    // Unknown first segment. APIs fail loudly. Pages: in local mode redirect
    // home (old unprefixed bookmarks like /agents land somewhere useful); in
    // prod, 404 — identical to the non-granted answer, so nothing leaks.
    if (isApi || pathname.startsWith("/api/")) return notFound();
    if (IS_LOCAL) return toHome(req);
    if (!user) return toLogin(req, true);
    return notFound();
  }

  if (!IS_LOCAL) {
    if (!user) return isApi ? NextResponse.json({ error: "Unauthorized" }, { status: 401 }) : toLogin(req, true);
    // Non-granted project: 404, not 403 — same answer as "doesn't exist".
    if (!userCanAccess(user, name)) return notFound();
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(PROJECT_HEADER, name);
  const url = req.nextUrl.clone();
  url.pathname = rest;
  const res = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  // Remember the last project for the "/" redirect (page navigations only —
  // don't churn the cookie on every API call).
  if (!isApi) {
    res.cookies.set("flow_last_project", name, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, IS_LOCAL, PROJECT_HEADER } from "@/lib/config";
import { listRegistryProjects, getRegistryProject, isValidProjectName } from "@/lib/registry";
import { verifySession, verifyPat, userCanAccess, userProjectFilter, loadAuthStore } from "@/lib/authStore";
import { remoteForOrigin } from "@/lib/machineConfig";

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
  "/api/deployment", // stable-identity probe for `flow connect` (pre-credential)
  "/install.sh", // one-command install bootstrap (curled by an unauth'd machine)
  "/_next",
  "/favicon.ico",
];

// Deployment-level API prefixes that carry no project scope but DO require a
// session in prod (enforced inside the routes themselves).
const DEPLOYMENT_API = ["/api/projects", "/api/access", "/api/tokens", "/api/machines"];

// The `/<project>/v1/*` machine surface a MEMBER (non-owner) PAT may use: the
// graph read/embed verbs, memory search/remember, transcript ingest, and
// advisory corrections — everything a coding agent, capture hook, or connector
// legitimately needs. Every OTHER /v1 segment (settings, sources, integrations,
// agents, work-folders, events) is an OWNER action. Critical: this PAT door
// forwards to the role-blind orchestrator with the project ADMIN token, so a
// member reaching a non-listed path here escalates past the dashboard's
// canManageIntegrations() gate. Enforce owner for anything off this list.
const MEMBER_V1_PREFIXES = new Set(["verbs", "embed", "journal", "reconcile", "memory", "ingest", "corrections"]);

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

async function routeRequest(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (DEPLOYMENT_API.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next(); // routes enforce their own session/role checks
  }

  // /connect — deployment-level page (device-flow approval + machine list).
  // Requires a session in prod; the ?code= param must survive the login
  // round-trip, so the redirect carries pathname + search (toLogin drops
  // search, which is fine everywhere else).
  if (pathname === "/connect") {
    if (!IS_LOCAL) {
      const u = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
      if (!u) {
        const url = req.nextUrl.clone();
        url.pathname = "/login";
        url.search = `?from=${encodeURIComponent(pathname + req.nextUrl.search)}`;
        return NextResponse.redirect(url);
      }
    }
    return NextResponse.next();
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

  // /<name>/mcp and /<name>/v1/* — the machine surface for coding agents:
  // remote MCP plus the verb/memory/embed/ingest endpoints the flow-mcp
  // wrapper, flow-hook shim, and CLI agent call. These carry a bearer PAT,
  // not a session cookie, so the page/API auth below doesn't apply. Leak
  // discipline preserved: missing/invalid token → 401 BEFORE project
  // resolution; valid token without a grant → 404, identical to nonexistent.
  // Local mode needs no token (single user on their own box).
  if (rest === "/mcp" || rest.startsWith("/v1/")) {
    let patUserId: string | null = null;
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
      patUserId = patUser.id;
      // Owner-only machine surface. Without this, a member PAT reaches the
      // role-blind orchestrator (guarded only by the admin token route.ts
      // injects) and performs owner actions — writing team settings, adding
      // sources, starting server-side agents — bypassing canManageIntegrations().
      // Members get the agent/capture surface only; everything else needs owner.
      if (rest.startsWith("/v1/") && patUser.role !== "owner") {
        const seg = rest.slice("/v1/".length).split("/")[0];
        if (!MEMBER_V1_PREFIXES.has(seg)) {
          return NextResponse.json({ error: "Owner only." }, { status: 403 });
        }
      }
    } else if (!project) {
      return notFound();
    }
    const fwdHeaders = new Headers(req.headers);
    fwdHeaders.set(PROJECT_HEADER, name);
    // Trusted attribution for ingest: strip any CLIENT-supplied value, then
    // stamp the verified PAT owner. The orchestrator namespaces captured
    // sessions by this so a member can't forge/append to another user's session.
    fwdHeaders.delete("x-flow-pat-user");
    if (patUserId) fwdHeaders.set("x-flow-pat-user", patUserId);
    const fwdUrl = req.nextUrl.clone();
    // /<name>/mcp → /mcp ; /<name>/v1/x → /v1/x  (route handlers resolve the
    // project + upstream from the header).
    fwdUrl.pathname = rest;
    return NextResponse.rewrite(fwdUrl, { request: { headers: fwdHeaders } });
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

// ── Cross-origin execution door (local mode only) ────────────────────────────
// A dashboard page served by a CONNECTED deployment (flow.acme.com) may call
// this machine's local Flow directly from the browser — that's how "run
// agents on my machine from the prod dashboard" works with zero relay and
// zero added latency. The door opens only when (a) this deployment runs in
// local mode, (b) the request's Origin matches a remote in ~/.flow/config.json
// (written by `flow connect`), and (c) the caller presents that remote's
// pairing secret in x-flow-pairing — without (c), any website open in the
// same browser could drive local agents. Chrome's Private Network Access
// preflight is answered explicitly (Access-Control-Allow-Private-Network).
// Unknown origins get no CORS headers at all: the request routes normally
// but the browser refuses to hand the response to the page.

const DOOR_HEADERS = "content-type, authorization, x-flow-pairing";

function addCors<T extends Response>(res: T, origin: string): T {
  res.headers.set("access-control-allow-origin", origin);
  res.headers.append("vary", "Origin");
  return res;
}

export async function proxy(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!IS_LOCAL || !origin || origin === req.nextUrl.origin) return routeRequest(req);

  const remote = remoteForOrigin(origin);
  if (!remote?.pairing) return routeRequest(req);

  if (req.method === "OPTIONS") {
    const res = new NextResponse(null, { status: 204 });
    addCors(res, origin);
    res.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.headers.set("access-control-allow-headers", DOOR_HEADERS);
    res.headers.set("access-control-max-age", "3600");
    if (req.headers.get("access-control-request-private-network") === "true") {
      res.headers.set("access-control-allow-private-network", "true");
    }
    return res;
  }

  if (req.headers.get("x-flow-pairing") !== remote.pairing) {
    return addCors(NextResponse.json({ error: "Invalid or missing pairing token" }, { status: 401 }), origin);
  }
  return addCors(await routeRequest(req), origin);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

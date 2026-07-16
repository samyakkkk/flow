// Auth helpers — server side only.
//
// requireSession() keeps its old contract (resolve this request to the
// project admin token, or null), so the ~30 API routes that call it did not
// change in the single-dashboard refactor. What changed underneath:
//
//   local: the project's admin token comes from the registry (per-request),
//          not from env — a single process serves every project.
//   prod:  the cookie is a signed {uid, exp} session for a real user account
//          in data/auth.json, NOT a project token. We verify the signature,
//          check the user's grant on this request's project, and only then
//          inject the project's admin token server-side. Humans never hold
//          project tokens anymore.
import { cookies } from "next/headers";
import { SESSION_COOKIE, IS_LOCAL } from "./config";
import { currentProject } from "./projectContext";
import { verifySession, userCanAccess, type AuthUser } from "./authStore";

/** The authenticated user for this request (prod), or null. Local mode has no users. */
export async function currentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

/**
 * Resolve this request to the scoped project's admin token — the bearer for
 * orchestrator/gateway calls. Returns null when unauthenticated, the project
 * is unknown, or (prod) the user has no grant on it.
 */
export async function requireSession(): Promise<string | null> {
  const project = await currentProject();
  if (!project) return null;
  if (IS_LOCAL) return project.adminToken || null;

  const user = await currentUser();
  if (!user) return null;
  if (!userCanAccess(user, project.name)) return null;
  return project.adminToken || null;
}

/** Prod-only: the request's user if they are an owner, else null. */
export async function requireOwner(): Promise<AuthUser | null> {
  const user = await currentUser();
  return user?.role === "owner" ? user : null;
}

/**
 * Legacy name for requireSession() — kept so the ~38 routes written against
 * the per-project-dashboard era compile unchanged. Same contract: the scoped
 * project's admin token, or null.
 */
export const getSessionToken = requireSession;

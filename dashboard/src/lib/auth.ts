// Auth helpers — server side only.
import { cookies } from "next/headers";
import { SESSION_COOKIE, ORCHESTRATOR_URL, IS_LOCAL, FLOW_ADMIN_TOKEN } from "./config";

/**
 * Validate a bearer token by hitting GET /v1/audit on the orchestrator.
 * Returns true if orchestrator responds 200.
 */
export async function validateToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/v1/audit?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Get the token stored in the session cookie (server component / route handler).
 */
export async function getSessionToken(): Promise<string | null> {
  // Local mode = single user on their own machine. The dashboard already holds
  // this project's admin token in its env, and it's authoritative here — use it
  // and ignore any cookie (a stale or cross-project one shouldn't force a
  // login on your own box). No paste-the-token step at all.
  if (IS_LOCAL && FLOW_ADMIN_TOKEN) return FLOW_ADMIN_TOKEN;
  // Prod: the cookie is the credential, and it's project-specific (validated
  // against this project's orchestrator), so cross-project cookies are rejected.
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Check if the current request is authenticated. Returns token or null.
 */
export async function requireSession(): Promise<string | null> {
  return getSessionToken();
}

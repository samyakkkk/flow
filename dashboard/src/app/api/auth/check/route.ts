import { NextResponse } from "next/server";
import { getSessionToken, validateToken } from "@/lib/auth";
import { IS_LOCAL, FLOW_ADMIN_TOKEN } from "@/lib/config";

// GET /api/auth/check — is the current session valid for THIS project's
// orchestrator? Runs in the Node server, so it reads this process's own
// ORCHESTRATOR_URL (correct per project even though all dashboards share one
// build). The proxy calls this to gate page navigations centrally.
//
// Status contract (the proxy redirects to /login ONLY on 401/403):
//   200 — authenticated
//   401 — the orchestrator explicitly rejected the credential (prod only)
//   503 — orchestrator unreachable/unhealthy: NOT an auth verdict. The proxy
//         fails open and pages render their own degraded state. Never bounce
//         someone to a login that validates against the same dead orchestrator.
export async function GET(): Promise<NextResponse> {
  // Local mode = single user on their own box; the env admin token is
  // authoritative and there is no login step that could improve anything.
  // No orchestrator round-trip: a local user can NEVER be sent to /login.
  if (IS_LOCAL && FLOW_ADMIN_TOKEN) return NextResponse.json({ ok: true });

  const token = await getSessionToken();
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });

  const check = await validateToken(token);
  if (check === "valid") return NextResponse.json({ ok: true });
  if (check === "invalid") return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: false, reason: "orchestrator unreachable" }, { status: 503 });
}

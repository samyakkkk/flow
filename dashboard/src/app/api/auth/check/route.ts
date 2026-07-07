import { NextResponse } from "next/server";
import { getSessionToken, validateToken } from "@/lib/auth";

// GET /api/auth/check — is the current session cookie valid for THIS project's
// orchestrator? Runs in the Node server, so it reads this process's own
// ORCHESTRATOR_URL (correct per project even though all dashboards share one
// build). Middleware calls this to gate page navigations centrally.
export async function GET(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });
  const valid = await validateToken(token);
  return valid
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ ok: false }, { status: 401 });
}

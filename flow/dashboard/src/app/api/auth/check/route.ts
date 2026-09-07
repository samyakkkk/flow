import { NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";

// GET /api/auth/check — is the current session valid? Deployment-level:
// local mode is always authenticated (single user, own box); prod verifies
// the signed session cookie against the auth store. Per-project grants are
// enforced by the proxy and requireSession(), not here. The login page uses
// this to bounce already-authenticated visitors.
export async function GET(): Promise<NextResponse> {
  if (IS_LOCAL) return NextResponse.json({ ok: true });
  const user = await currentUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true });
}

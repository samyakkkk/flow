import { NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";
import { createPreblessedRequest } from "@/lib/deviceFlow";

// POST /api/auth/device/prebless — the one-command install's server half.
// The dashboard page is already authenticated, so it mints a pre-approved
// connect code tied to this user and bakes it into the copy-paste install
// command. `flow connect <url> --code <code>` then completes it with the
// machine's pairing — no second browser round-trip. 10-min single-use.
export async function POST() {
  if (IS_LOCAL) {
    return NextResponse.json(
      { error: "Local deployments need no connect — the dashboard and CLI already share the machine." },
      { status: 400 }
    );
  }
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const code = createPreblessedRequest(user.id);
  if (!code) {
    return NextResponse.json({ error: "Too many pending connect attempts — try again in a few minutes." }, { status: 429 });
  }
  return NextResponse.json({ code });
}

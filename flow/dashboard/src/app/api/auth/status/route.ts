import { NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";
import { loadAuthStore } from "@/lib/authStore";

// GET /api/auth/status — what should the login page render?
//   local            → no login at all (client bounces home)
//   prod, no users   → first-run bootstrap form (setup code from `flow up`)
//   prod, users      → email + password form
// Also reports the current user (for Settings' account section).
export async function GET() {
  if (IS_LOCAL) return NextResponse.json({ mode: "local", needsBootstrap: false });
  const store = loadAuthStore();
  const needsBootstrap = !store || store.users.length === 0;
  const user = await currentUser();
  return NextResponse.json({
    mode: "prod",
    needsBootstrap,
    user: user ? { id: user.id, email: user.email, role: user.role } : null,
  });
}

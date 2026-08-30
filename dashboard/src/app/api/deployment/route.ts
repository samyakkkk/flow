import { NextResponse } from "next/server";
import { loadAuthStore } from "@/lib/authStore";

// GET /api/deployment — the deployment's stable identity, unauthenticated.
// `flow connect` reads this BEFORE it holds any credential, to key the remote
// by a URL-independent id: a moved box / changed IP / renamed DNS resolves to
// the same deployment and updates the existing entry in place. Deliberately
// leaks nothing sensitive — just the id and a display name (never users,
// tokens, or project list). Local mode has no auth store, so returns null.
export async function GET() {
  const store = loadAuthStore();
  if (!store?.deploymentId) {
    return NextResponse.json({ deploymentId: null }, { status: 200 });
  }
  return NextResponse.json({
    deploymentId: store.deploymentId,
    name: store.deploymentName ?? null,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";
import { loadAuthStore, saveAuthStore, mintPat } from "@/lib/authStore";

// Personal access tokens — the machine credential for MCP/gateway access,
// inheriting the minting user's project grants. Prod only: in local mode the
// project admin token (data/projects/<name>/.env) remains the MCP credential.
// GET  /api/tokens          → own tokens (no secrets)
// POST /api/tokens {label}  → mint; the full token appears ONCE in the response

function guard() {
  if (IS_LOCAL) {
    return NextResponse.json(
      { error: "Personal tokens are a prod-mode feature — in local mode use the project admin token from data/projects/<name>/.env" },
      { status: 400 }
    );
  }
  return null;
}

export async function GET() {
  const g = guard();
  if (g) return g;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  return NextResponse.json({
    tokens: store.tokens
      .filter((t) => t.userId === user.id)
      .map((t) => ({ id: t.id, label: t.label, createdAt: t.createdAt })),
  });
}

export async function POST(req: NextRequest) {
  const g = guard();
  if (g) return g;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "unnamed";

  const store = loadAuthStore();
  if (!store) return NextResponse.json({ error: "Auth store missing" }, { status: 503 });
  const { token, record } = mintPat(user.id, label);
  store.tokens.push(record);
  saveAuthStore(store);
  return NextResponse.json({ ok: true, id: record.id, token }); // token shown once
}

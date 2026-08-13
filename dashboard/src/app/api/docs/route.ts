import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET  /api/docs                     → chapter list (no bodies)
// GET  /api/docs?scope=X&chapter=Y   → one chapter with body_md
// GET  /api/docs?q=…                 → excerpt search across chapters
// POST /api/docs {scope?, force?}    → recompose (proxies /v1/docs/rebuild)
// Thin proxies to the orchestrator, which owns composition + freshness.

export async function GET(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const chapter = url.searchParams.get("chapter");
  const q = url.searchParams.get("q");
  const path = q
    ? `/v1/docs/search?q=${encodeURIComponent(q)}`
    : scope && chapter
      ? `/v1/docs/${encodeURIComponent(scope)}/${encodeURIComponent(chapter)}`
      : `/v1/docs${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`;
  try {
    const res = await orcFetch(path, token);
    if (!res.ok) return NextResponse.json({ error: `Orchestrator ${res.status}` }, { status: res.status === 404 ? 404 : 502 });
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Orchestrator unreachable" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { scope?: string | null; force?: boolean };
  try {
    const res = await orcFetch(`/v1/docs/rebuild`, token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: body.scope ?? null, force: body.force === true }),
    });
    if (!res.ok) return NextResponse.json({ error: `Orchestrator ${res.status}` }, { status: 502 });
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Orchestrator unreachable" }, { status: 502 });
  }
}

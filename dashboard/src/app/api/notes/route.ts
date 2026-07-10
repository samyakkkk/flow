import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// GET /api/notes — recent branch notes (Flow-side working memory) for the
// Inbox strip. DELETE /api/notes?id= — the one human curation act.

export async function GET(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const qs = new URLSearchParams();
  for (const k of ["repo", "branch", "status", "limit"]) {
    const v = url.searchParams.get(k);
    if (v) qs.set(k, v);
  }
  try {
    const res = await orcFetch(`/v1/notes${qs.size ? `?${qs}` : ""}`, token);
    if (!res.ok) return NextResponse.json({ error: `Orchestrator ${res.status}`, rows: [] }, { status: 502 });
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Orchestrator unreachable", rows: [] }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const res = await orcFetch(`/v1/notes/${encodeURIComponent(id)}`, token, { method: "DELETE" });
    return NextResponse.json(await res.json(), { status: res.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Orchestrator unreachable" }, { status: 502 });
  }
}

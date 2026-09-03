import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// DELETE /api/memory?id=<uuid>&type=memory|observation — the Knowledge Base's
// one curation act, proxied to the orchestrator's cascade-delete routes.

export async function DELETE(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const type = url.searchParams.get("type") === "observation" ? "observation" : "memory";
  const path =
    type === "observation"
      ? `/v1/memory/observation/${encodeURIComponent(id)}`
      : `/v1/memory/${encodeURIComponent(id)}`;
  try {
    const res = await orcFetch(path, token, { method: "DELETE" });
    if (!res.ok) return NextResponse.json({ error: `Orchestrator ${res.status}` }, { status: res.status === 404 ? 404 : 502 });
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Orchestrator unreachable" }, { status: 502 });
  }
}

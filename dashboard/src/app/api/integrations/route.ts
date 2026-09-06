// /api/integrations — proxy to the orchestrator's local `flow setup` surface.
// GET: connected repos + detected tools; POST: connect a folder; DELETE: remove.
import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";
import { requireProject } from "@/lib/projectContext";
import { loadAuthStore } from "@/lib/authStore";
import { orcFetch } from "@/lib/orchestrator";

export async function GET(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!IS_LOCAL) {
    const user = await currentUser(), project = await requireProject();
    const workspaces = (loadAuthStore()?.tokens ?? []).filter(t => t.userId === user?.id && t.projects?.includes(project.name) && t.workspace?.configuredAt).map(t => ({ id: t.id, ...t.workspace }));
    return NextResponse.json({ project: project.name, mode: "prod", repos: [], detected: [], all: [], version: 1, workspaces });
  }
  try {
    const res = await orcFetch("/v1/integrations/status", token);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach orchestrator: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!IS_LOCAL) return NextResponse.json({ error: "Run Flow setup on your computer" }, { status: 403 });
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { path?: string; harnesses?: string[]; share?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const res = await orcFetch("/v1/integrations/setup", token, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach orchestrator: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!IS_LOCAL) return NextResponse.json({ error: "Remove local integrations from your computer; revoke credentials in Access" }, { status: 403 });
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { path?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const res = await orcFetch("/v1/integrations/remove", token, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach orchestrator: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

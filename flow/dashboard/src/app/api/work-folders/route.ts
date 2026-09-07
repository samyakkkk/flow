import { NextRequest, NextResponse } from "next/server";
import { currentUser, getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

// Per-user work folders — where THIS user's agent sessions run. The owner is
// resolved server-side from the session (never trusted from the client), so
// one user's local paths can never appear in a teammate's dashboard.
async function owner(): Promise<string> {
  const user = await currentUser();
  return user?.email ?? "local";
}

export async function GET(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const res = await orcFetch(`/v1/work-folders?owner=${encodeURIComponent(await owner())}`, token);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await req.json()) as { path?: string; repo?: string };
    const res = await orcFetch(`/v1/work-folders`, token, {
      method: "POST",
      body: JSON.stringify({ owner: await owner(), path: body.path, repo: body.repo }),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await req.json()) as { path?: string };
    const res = await orcFetch(`/v1/work-folders`, token, {
      method: "DELETE",
      body: JSON.stringify({ owner: await owner(), path: body.path }),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

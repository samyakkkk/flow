import { NextRequest, NextResponse } from "next/server";
import { getSessionToken, canManageIntegrations } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

export interface SettingItem {
  key: string;
  secret: boolean;
  description: string;
  source: "db" | "env" | "default" | "unset";
  value: string | null;
  set: boolean;
}

export async function GET(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const res = await orcFetch("/v1/settings", token);
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach orchestrator: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await canManageIntegrations())) {
    return NextResponse.json({ error: "Settings are managed by an owner." }, { status: 403 });
  }

  let body: Record<string, string>;
  try {
    body = (await req.json()) as Record<string, string>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const res = await orcFetch("/v1/settings", token, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach orchestrator: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

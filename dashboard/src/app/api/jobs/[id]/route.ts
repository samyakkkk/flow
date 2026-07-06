import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcGet } from "@/lib/orchestrator";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const data = await orcGet(`/v1/jobs/${id}`, token);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

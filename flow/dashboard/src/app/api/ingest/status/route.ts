import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcGet } from "@/lib/orchestrator";

interface IngestSourceRow {
  source: string;
  resource: string;
  cursor: string;
  last_poll_at: number;
  lag_seconds: number | null;
  catching_up: boolean;
  status: string;
}

interface IngestStatusResponse {
  sources: IngestSourceRow[];
}

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const data = await orcGet<IngestStatusResponse>("/v1/ingest/status", token);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ sources: [] });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcPost } from "@/lib/orchestrator";

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { question: string };
  if (!body.question?.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  try {
    // wait=true: orchestrator polls up to 30s and returns answer or job id
    const data = await orcPost("/v1/ask", token, { question: body.question, wait: true });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

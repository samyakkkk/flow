import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { requireProject } from "@/lib/projectContext";

// POST { id: number, decision: "approve" | "dismiss" }
// Proxies to orchestrator PATCH /v1/outbox/:id. Approve replays the original
// event in auto mode server-side; dismiss closes the proposal.
export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { id?: number; decision?: "approve" | "dismiss" };
  if (!body.id || !body.decision) {
    return NextResponse.json({ error: "id and decision required" }, { status: 400 });
  }

  const project = await requireProject();
  const res = await fetch(`${project.orchestratorUrl}/v1/outbox/${body.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ decision: body.decision }),
  });

  return NextResponse.json(await res.json(), { status: res.status });
}

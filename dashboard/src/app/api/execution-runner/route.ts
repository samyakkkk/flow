import { NextResponse } from "next/server";
import { listRegistryProjects } from "@/lib/registry";

// GET /api/execution-runner — which local project is THIS machine's execution
// runner: the gateway-less orchestrator `flow connect` stands up to run coding
// agents against a connected cloud's brain. Deployment-level (no project
// scope), reachable cross-origin through the execution door so a cloud page can
// ask "where do I run?" before it creates a session. Returns the runner's name
// (used as /<name>/api/agents/sessions), or null if none is set up yet. Only a
// name — no secret — and the door already gates on the pairing token.
export async function GET() {
  const runner = listRegistryProjects().find((p) => p.kind === "runner") ?? null;
  return NextResponse.json({ project: runner?.name ?? null });
}

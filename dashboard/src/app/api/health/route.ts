import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { requireProject } from "@/lib/projectContext";

async function checkService(url: string, token?: string, path = "/health"): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const start = Date.now();
  try {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${url}${path}`, { headers, cache: "no-store", signal: AbortSignal.timeout(4000) });
    const latencyMs = Date.now() - start;
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      // The gateway process being up is not the same as the brain being
      // usable — deep health reports the FalkorDB probe alongside it.
      const falkor = data.falkordb as { ok?: boolean; error?: string } | undefined;
      const ok = falkor ? falkor.ok !== false : true;
      return { ok, latencyMs, detail: ok ? JSON.stringify(data) : `FalkorDB unreachable: ${falkor?.error ?? "no reply"}` };
    }
    return { ok: false, latencyMs, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, detail: (e as Error).message };
  }
}

export async function GET() {
  const token = await getSessionToken();
  const project = await requireProject();
  const [orc, gw] = await Promise.all([
    checkService(project.orchestratorUrl, token ?? undefined),
    // deep=1: also ping FalkorDB through the gateway, so "gateway up but the
    // graph DB is dead" shows as unhealthy instead of a green tick.
    checkService(project.gatewayUrl, undefined, "/health?deep=1"),
  ]);
  return NextResponse.json({ orchestrator: orc, gateway: gw });
}

import { NextResponse } from "next/server";
import { ORCHESTRATOR_URL, GATEWAY_URL } from "@/lib/config";
import { getSessionToken } from "@/lib/auth";

async function checkService(url: string, token?: string): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const start = Date.now();
  try {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${url}/health`, { headers, cache: "no-store", signal: AbortSignal.timeout(4000) });
    const latencyMs = Date.now() - start;
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      return { ok: true, latencyMs, detail: JSON.stringify(data) };
    }
    return { ok: false, latencyMs, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, detail: (e as Error).message };
  }
}

export async function GET() {
  const token = await getSessionToken();
  const [orc, gw] = await Promise.all([
    checkService(ORCHESTRATOR_URL, token ?? undefined),
    checkService(GATEWAY_URL),
  ]);
  return NextResponse.json({ orchestrator: orc, gateway: gw });
}

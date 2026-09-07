import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";

async function proxy(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { path } = await context.params;
  const route = path.join("/");
  if (!/^(tasks(?:\/[a-zA-Z0-9-]+(?:\/(?:followup|command|cancel|diff))?)?|setup\/[a-zA-Z0-9-]+|repos\/[^/]+\/env)$/.test(route))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const response = await orcFetch(`/v1/agents/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`, token, {
      method: req.method, ...(req.method === "GET" ? {} : { body: await req.text() }),
    });
    return NextResponse.json(await response.json(), { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Cloud worker unavailable" }, { status: 502 }); }
}
export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };

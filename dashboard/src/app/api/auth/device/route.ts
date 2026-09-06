import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL } from "@/lib/config";
import { currentUser } from "@/lib/auth";
import { loadAuthStore, saveAuthStore, verifyPat, userCanAccess } from "@/lib/authStore";
import { getRegistryProject } from "@/lib/registry";
import { startPairing, readTicket, approvePairing, redeemPairing } from "@/lib/devicePairing";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (IS_LOCAL) return json({ error: "Browser pairing requires a team deployment" }, 400);
  if (Number(req.headers.get("content-length")) > 4096) return json({ error: "Request too large" }, 413);
  try {
    const raw = await req.text();
    if (raw.length > 4096) return json({ error: "Request too large" }, 413);
    const b = JSON.parse(raw);
    if (b.action === "start") {
      if (typeof b.project !== "string" || !getRegistryProject(b.project)) return json({ error: "Unknown project" }, 404);
      return json(startPairing(b.project, b.machine, b.workspace, b.challenge));
    }
    if (b.action === "poll") return json(redeemPairing(b.ticket, b.secret));
    if (b.action === "inspect" || b.action === "approve" || b.action === "deny") {
      // Browser mutations need same-origin proof in addition to SameSite cookies.
      const origin = req.headers.get("origin");
      const host = req.headers.get("host");
      if (!origin || new URL(origin).host !== host || req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Same-origin browser request required" }, 403);
      const user = await currentUser();
      if (!user) return json({ error: "Sign in first" }, 401);
      const t = readTicket(b.ticket);
      if (!userCanAccess(user, t.project)) return json({ error: "Project access denied" }, 403);
      if (b.action !== "inspect") approvePairing(b.ticket, user, b.action === "deny");
      return json({ project: t.project, machine: t.machine, workspace: t.workspace, code: t.id.slice(0, 8).toUpperCase(), user: user.email });
    }
    if (b.action === "complete") {
      const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const user = verifyPat(bearer), s = loadAuthStore();
      const record = s?.tokens.find(t => t.id === bearer.split("_")[1]);
      if (!user || !s || !record?.workspace || !record.projects?.length || !userCanAccess(user, record.projects[0], s)) return json({ error: "Unauthorized" }, 401);
      const all = ["claude", "codex", "cursor", "gemini", "opencode", "antigravity", "copilot"];
      if (!Array.isArray(b.harnesses) || b.harnesses.length > 7 || b.harnesses.some((h: unknown) => typeof h !== "string" || !all.includes(h))) return json({ error: "Invalid tools" }, 400);
      record.workspace.harnesses = [...new Set<string>(b.harnesses)];
      record.workspace.configuredAt = new Date().toISOString();
      saveAuthStore(s);
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Setup failed" }, 400); }
}

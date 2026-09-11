import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { readLocalConfig, writeLocalConfig } from "@/lib/localConfig";
import { requireProject } from "@/lib/projectContext";
import { orcFetch } from "@/lib/orchestrator";

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cfg = readLocalConfig(await requireProject());
  // Return which keys are set (not the values)
  return NextResponse.json({
    linear_key: !!cfg["linear_key"],
    slack_bot_token: !!cfg["slack_bot_token"],
    slack_app_token: !!cfg["slack_app_token"],
    fireflies_key: !!cfg["fireflies_key"],
    pending_repos: cfg["pending_repos"] ? JSON.parse(cfg["pending_repos"]) : [],
  });
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as Record<string, unknown>;
  const kind = body.kind as string;

  if (kind === "keys") {
    // Store integration keys locally
    const updates: Record<string, string> = {};
    if (body.linear_key) updates["linear_key"] = body.linear_key as string;
    if (body.slack_bot_token) updates["slack_bot_token"] = body.slack_bot_token as string;
    if (body.slack_app_token) updates["slack_app_token"] = body.slack_app_token as string;
    if (body.fireflies_key) updates["fireflies_key"] = body.fireflies_key as string;
    writeLocalConfig(await requireProject(), updates);
    return NextResponse.json({ ok: true });
  }

  if (kind === "repo") {
    // Add a pending repo connection record
    const cfg = readLocalConfig(await requireProject());
    const existing: Array<Record<string, unknown>> = cfg["pending_repos"]
      ? JSON.parse(cfg["pending_repos"])
      : [];
    const branch = typeof body.branch === "string" ? body.branch.trim() || undefined : undefined;
    const entry = {
      url: body.url,
      branch,
      localClone: body.localClone ?? false,
      addedAt: new Date().toISOString(),
      status: "pending",
    };
    existing.push(entry);
    writeLocalConfig(await requireProject(), { pending_repos: JSON.stringify(existing) });

    // Post a dashboard event to orchestrator so the pipeline can pick it up
    await orcFetch("/v1/events", token, {
      method: "POST",
      body: JSON.stringify({
        source: "dashboard",
        type: "repo_added",
        ts: Date.now(),
        payload: { url: body.url, branch, localClone: body.localClone ?? false },
      }),
    });

    return NextResponse.json({
      ok: true,
      note: "Repo queued. Run index-workspace/scripts/add-repo.mjs to index it, or wait for the orchestrator job runner.",
      entry,
    });
  }

  if (kind === "meeting_notes") {
    // Ingest manual meeting notes as a dashboard event
    const text = body.text as string;
    if (!text?.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });
    const res = await orcFetch("/v1/events", token, {
      method: "POST",
      body: JSON.stringify({
        source: "meeting",
        type: "manual_upload",
        ts: Date.now(),
        payload: { text, title: body.title ?? "Manual upload" },
      }),
    });
    const data = await res.json() as unknown;
    return NextResponse.json(data);
  }

  return NextResponse.json({ error: `Unknown kind: ${kind}` }, { status: 400 });
}

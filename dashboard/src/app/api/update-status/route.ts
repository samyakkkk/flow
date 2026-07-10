import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSessionToken } from "@/lib/auth";

const exec = promisify(execFile);

// How far the flow checkout is behind its upstream — powers the "update
// available" badge in the nav for long-running installs (flow up applies
// updates at start, but a dashboard that's been up for days never sees that).
//
// Mirrors the CLI's maybeSelfUpdate guards (bin/flow.mjs): only reports
// commits that `flow up` would actually apply — clean worktree, on the
// default branch, fast-forwardable. A dirty dev checkout reports 0 rather
// than nagging about updates the CLI would refuse to pull.
//
// git fetch hits the network, so results are cached for 30 minutes across
// requests (and across the multiple per-project dashboards sharing this
// checkout — each runs its own process, so each caches independently).

interface UpdateStatus {
  behind: number;
  current?: string;
  latest?: string;
  checkedAt: number;
}

const TTL_MS = 30 * 60 * 1000;
let cache: UpdateStatus | null = null;

// dashboard/ is spawned with cwd = <flow root>/dashboard (bin/flow.mjs).
const FLOW_ROOT = resolve(process.cwd(), "..");

async function git(args: string[], timeoutMs = 10000): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: FLOW_ROOT, timeout: timeoutMs });
  return stdout.trim();
}

async function checkUpstream(): Promise<UpdateStatus> {
  const none: UpdateStatus = { behind: 0, checkedAt: Date.now() };
  if (!existsSync(join(FLOW_ROOT, ".git"))) return none;
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== "main" && branch !== "master") return none;
    if (await git(["status", "--porcelain"])) return none; // dirty dev checkout
    await git(["rev-parse", "--abbrev-ref", "@{u}"]); // throws when no upstream
    await git(["fetch", "--quiet"], 15000);
    const behind = Number(await git(["rev-list", "--count", "HEAD..@{u}"]));
    if (!behind) return none;
    return {
      behind,
      current: await git(["rev-parse", "--short", "HEAD"]),
      latest: await git(["rev-parse", "--short", "@{u}"]),
      checkedAt: Date.now(),
    };
  } catch {
    return none; // offline / detached / no upstream — never surface an error
  }
}

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!cache || Date.now() - cache.checkedAt > TTL_MS) {
    cache = await checkUpstream();
  }
  return NextResponse.json(cache);
}

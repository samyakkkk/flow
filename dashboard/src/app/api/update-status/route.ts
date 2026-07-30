import { NextResponse } from "next/server";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { getSessionToken, requireOwner } from "@/lib/auth";
import { FLOW_DATA_DIR, IS_LOCAL } from "@/lib/config";

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

// Identifies THIS dashboard process. flow up restarts the dashboard, so the
// update banner knows the install landed when the bootId it polls changes.
const BOOT_ID = randomBytes(8).toString("hex");

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!cache || Date.now() - cache.checkedAt > TTL_MS) {
    cache = await checkUpstream();
  }
  return NextResponse.json({ ...cache, bootId: BOOT_ID });
}

// Tapping the banner runs the same command the old badge told users to type:
// `flow up`. The CLI owns the whole update path — ff-only pull, npm install
// when the lockfile moved, dashboard rebuild, restart of every service
// INCLUDING this process — so the child must be detached, with output going
// to data/logs/self-update.log. The client keeps polling GET and reloads when
// bootId changes. The cache is deliberately left alone here: polling must not
// trigger a fresh `git fetch` while the updater is mid-pull.
let installStartedAt = 0;

export async function POST() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!IS_LOCAL && !(await requireOwner())) {
    return NextResponse.json({ error: "Only owners can install updates" }, { status: 403 });
  }
  // Double-tap / multi-tab guard; a successful install replaces this process,
  // so the flag clearing itself on restart is exactly right.
  if (installStartedAt && Date.now() - installStartedAt < 10 * 60 * 1000) {
    return NextResponse.json({ ok: true, alreadyRunning: true, bootId: BOOT_ID });
  }
  installStartedAt = Date.now();

  const logDir = join(FLOW_DATA_DIR, "logs");
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, "self-update.log"), "a");
  writeSync(fd, `\n── update triggered from dashboard ${new Date().toISOString()} ──\n`);

  // The env flow up gave THIS process would leak into the services the child
  // spawns ({...process.env, ...env}) — strip the dashboard-specific parts and
  // let the CLI re-derive them.
  const stripped = ["PORT", "NODE_ENV", "FLOW_DATA_DIR", "FLOW_AUTH_PATH", "FLOW_MODE"];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !stripped.includes(k)),
  ) as NodeJS.ProcessEnv;

  const child = spawn(process.execPath, [join(FLOW_ROOT, "bin", "flow.mjs"), "up"], {
    cwd: FLOW_ROOT,
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  closeSync(fd);
  return NextResponse.json({ ok: true, bootId: BOOT_ID });
}

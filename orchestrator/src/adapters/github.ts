// adapters/github.ts — GitHub integration adapter.
//
// 1. POST /v1/webhooks/github — receives push events, validates
//    X-Hub-Signature-256 when GITHUB_WEBHOOK_SECRET set, normalises to
//    github NormalizedEvent (repo, branch, commit). Only emits when branch
//    matches a registered repo's watched branch.
//    Webhook is an optional "poll-now" accelerator: on valid push it calls
//    pollNow("github") so the poller runs immediately rather than waiting.
//
// 2. Poll mode — uses the shared engine (pollers/engine.ts).
//    Interval: FLOW_GITHUB_POLL_MS env (default 60 000 ms).
//    Cursor: JSON {repo: lastSeenSha} for all registered repos.
//    On first run cursor="" → seeds known HEADs without emitting events
//    (avoids treating all existing commits as new on first boot).
//    Enabled unless FLOW_GITHUB_POLL_DISABLE=1.
//
// 3. Helpers: cloneRepo(url, branch, dest, {pat?}), listPRs(repo), getPR(repo, n).

import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { processEvent } from "../events.js";
import type { NormalizedEvent } from "../events.js";
import { registerPoller, pollNow } from "../pollers/engine.js";
import type { FetchResult } from "../pollers/engine.js";
import { getSetting } from "../settings.js";

// ------------------------------------------------------------------
// Registered repos: {owner/repo → watched branch}
// In production these come from the config DB; we support env override too.
// ------------------------------------------------------------------

export const registeredRepos: Map<string, string> = new Map([
  ["acme/api-service", "main"],
  ["acme/web-app", "main"],
]);

// Allow env override: FLOW_WATCHED_REPOS='owner/repo:branch,owner/repo:branch'
if (process.env.FLOW_WATCHED_REPOS) {
  for (const entry of process.env.FLOW_WATCHED_REPOS.split(",")) {
    const [repo, branch] = entry.trim().split(":");
    if (repo && branch) registeredRepos.set(repo, branch);
  }
}

// Watch a repo's branch at runtime (dashboard repo_added flow).
export function watchRepo(ownerRepo: string, branch: string): void {
  registeredRepos.set(ownerRepo, branch);
}

// Stop watching (repo_removed flow). Accepts either the exact "owner/repo"
// key or a bare repo name — the caller may no longer know the URL because
// the registry entry was already deleted by the dashboard.
export function unwatchRepo(ownerRepoOrName: string): boolean {
  if (registeredRepos.delete(ownerRepoOrName)) return true;
  for (const key of registeredRepos.keys()) {
    if (key.endsWith(`/${ownerRepoOrName}`)) {
      registeredRepos.delete(key);
      return true;
    }
  }
  return false;
}

// "owner/repo" from an https or ssh GitHub URL; null for non-GitHub URLs.
export function ownerRepoFromUrl(url: string): string | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// Check if gh CLI is authenticated (cached for 5 min to avoid spawning on every tick).
let _ghAuthCache: { ok: boolean; at: number } | null = null;
const GH_AUTH_TTL_MS = 5 * 60 * 1000;

export function ghAuthOk(): boolean {
  if (_ghAuthCache && Date.now() - _ghAuthCache.at < GH_AUTH_TTL_MS) return _ghAuthCache.ok;
  try {
    execSync("gh auth status", { stdio: "ignore", timeout: 5000 });
    _ghAuthCache = { ok: true, at: Date.now() };
  } catch {
    _ghAuthCache = { ok: false, at: Date.now() };
  }
  return _ghAuthCache.ok;
}

// registeredRepos only lives in memory, so repos added via the dashboard
// would stop being watched after a restart — re-seed from the workspace
// registry (repos.json), which is the durable record of {url, branch}.
export async function seedWatchedRepos(): Promise<void> {
  const { listWorkspaceRepos } = await import("../opencode.js");
  for (const r of listWorkspaceRepos()) {
    const ownerRepo = r.url ? ownerRepoFromUrl(r.url) : null;
    if (ownerRepo) registeredRepos.set(ownerRepo, r.branch || "main");
  }
}

// ------------------------------------------------------------------
// GitHub REST helpers
// ------------------------------------------------------------------

function githubPAT(): string {
  // Priority: DB setting > legacy env > gh CLI token (if available)
  const direct = getSetting("GITHUB_TOKEN") ?? process.env.GITHUB_PAT ?? process.env.GITHUB_TOKEN ?? "";
  if (direct) return direct;
  // Fallback: gh CLI token (works if gh auth is configured)
  try {
    return execSync("gh auth token 2>/dev/null", { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function githubHeaders(): Record<string, string> {
  const pat = githubPAT();
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(pat ? { Authorization: `Bearer ${pat}` } : {}),
  };
}

export interface PR {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string };
}

export async function listPRs(repo: string, state: "open" | "closed" | "all" = "open"): Promise<PR[]> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls?state=${state}&per_page=30`,
    { headers: githubHeaders() }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub listPRs HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as PR[];
}

export async function getPR(repo: string, prNumber: number): Promise<PR> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
    { headers: githubHeaders() }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub getPR HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as PR;
}

// ------------------------------------------------------------------
// Clone helpers
// ------------------------------------------------------------------

export interface CloneOpts {
  pat?: string;        // inject PAT into https URL
  depth?: number;      // shallow clone depth (default 1)
  force?: boolean;     // re-clone if dest already exists
}

/**
 * Clone a repo into dest. Supports PAT injection for private repos
 * and falls back to plain https (ambient gh auth / credential store).
 */
export function cloneRepo(
  url: string,
  branch: string,
  dest: string,
  opts: CloneOpts = {}
): { sha: string; path: string } {
  const { pat, depth = 1, force = false } = opts;

  if (existsSync(dest)) {
    if (!force) {
      // Already cloned — just get HEAD sha
      const result = spawnSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf-8" });
      return { sha: result.stdout.trim(), path: dest };
    }
    // Remove and re-clone
    spawnSync("rm", ["-rf", dest]);
  }

  mkdirSync(dest, { recursive: true });

  // Build clone URL (inject PAT for private HTTPS)
  let cloneUrl = url;
  if (pat && url.startsWith("https://")) {
    cloneUrl = url.replace("https://", `https://x-access-token:${pat}@`);
  }

  const args = [
    "clone",
    "--branch", branch,
    "--depth", String(depth),
    "--single-branch",
    cloneUrl,
    dest,
  ];

  const result = spawnSync("git", args, { encoding: "utf-8", timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(`git clone failed: ${result.stderr}`);
  }

  const shaResult = spawnSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf-8" });
  return { sha: shaResult.stdout.trim(), path: dest };
}

// ------------------------------------------------------------------
// ls-remote HEAD SHA (no clone needed)
// ------------------------------------------------------------------

export function lsRemoteHead(url: string, branch: string, pat?: string): string {
  let cloneUrl = url;
  if (pat && url.startsWith("https://")) {
    cloneUrl = url.replace("https://", `https://x-access-token:${pat}@`);
  }
  const result = spawnSync(
    "git",
    ["ls-remote", cloneUrl, `refs/heads/${branch}`],
    { encoding: "utf-8", timeout: 30_000 }
  );
  if (result.status !== 0) throw new Error(`git ls-remote failed: ${result.stderr}`);
  const line = result.stdout.trim().split("\n")[0];
  if (!line) throw new Error(`Branch ${branch} not found on ${url}`);
  return line.split("\t")[0].trim();
}

// ------------------------------------------------------------------
// Webhook signature validation
// ------------------------------------------------------------------

function verifyGithubSignature(secret: string, rawBody: Buffer, sigHeader: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  // Constant-time compare via hmac trick
  try {
    return createHmac("sha256", "timing-safe")
      .update(expected)
      .digest("hex") ===
      createHmac("sha256", "timing-safe")
        .update(sigHeader)
        .digest("hex");
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Poller: fetchSince implementation
//
// Cursor shape: JSON object {repo: lastSeenSha} for all registered repos.
// On first boot cursor is "" → seed known HEADs, emit no events.
// Subsequent polls: emit push event only when SHA differs from cursor.
// ------------------------------------------------------------------

function repoUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

export async function githubFetchSince(cursor: string): Promise<FetchResult> {
  // Parse cursor
  let knownHeads: Record<string, string> = {};
  if (cursor) {
    try {
      knownHeads = JSON.parse(cursor) as Record<string, string>;
    } catch {
      knownHeads = {};
    }
  }

  const pat = githubPAT();
  const events: NormalizedEvent[] = [];
  const newHeads: Record<string, string> = { ...knownHeads };

  const isFirstBoot = !cursor;

  for (const [repo, branch] of registeredRepos) {
    try {
      const sha = lsRemoteHead(repoUrl(repo), branch, pat || undefined);
      const prev = knownHeads[repo];

      if (!isFirstBoot && prev !== undefined && prev !== sha) {
        // New commit detected — emit push event
        events.push({
          id: randomUUID(),
          source: "github",
          type: "push",
          ts: Date.now(),
          payload: { repo, branch, commit: sha, prev_commit: prev },
        });
      }

      newHeads[repo] = sha;
    } catch (err) {
      // Log but don't fail the whole fetch — one repo error should not block others
      console.error(`[github-poller] Error checking ${repo}: ${err}`);
    }
  }

  return {
    events,
    nextCursor: JSON.stringify(newHeads),
  };
}

// ------------------------------------------------------------------
// Register poller with the engine
// ------------------------------------------------------------------

export function registerGithubPoller(): void {
  const intervalMs = parseInt(
    getSetting("FLOW_GITHUB_POLL_MS") ?? process.env.FLOW_GITHUB_POLL_MS ?? "60000",
    10
  );

  registerPoller({
    source: "github",
    intervalMs,
    fetchSince: githubFetchSince,
    enabled(): boolean {
      // GitHub poller: enabled if repos are registered and git can authenticate
      // (gh CLI auth, GITHUB_TOKEN in env/DB, or SSH keys — git ls-remote handles it).
      return (
        process.env.FLOW_GITHUB_POLL_DISABLE !== "1" &&
        process.env.FLOW_POLL_DISABLE !== "1" &&
        registeredRepos.size > 0 &&
        (Boolean(getSetting("GITHUB_TOKEN") ?? process.env.GITHUB_PAT ?? "") || ghAuthOk())
      );
    },
  });
}

// ------------------------------------------------------------------
// Webhook route registration
// Webhook = optional poll-now accelerator (system.md contract).
// A valid push webhook triggers pollNow("github") rather than
// processing the event itself — the poller is the single ingestion path.
// ------------------------------------------------------------------

export function registerGithubWebhook(app: FastifyInstance): void {
  // Raw body is pre-parsed by the global content-type parser in index.ts
  // and attached as req._rawBody. req.body is already parsed JSON.
  app.post("/v1/webhooks/github", async (req, reply) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const rawBody = (req as unknown as Record<string, Buffer>)._rawBody ?? Buffer.from(JSON.stringify(req.body));

    if (secret) {
      const sig = (req.headers["x-hub-signature-256"] as string | undefined) ?? "";
      if (!verifyGithubSignature(secret, rawBody, sig)) {
        return reply.code(401).send({ error: "Invalid signature" });
      }
    }

    // Body is already parsed by the global content-type parser
    const payload = req.body as Record<string, unknown>;
    const event_type = req.headers["x-github-event"] as string | undefined;

    // Only handle push events
    if (event_type !== "push") {
      return reply.code(200).send({ ok: true, skipped: true, event_type });
    }

    const ref = payload.ref as string | undefined; // e.g. "refs/heads/main"
    const branch = ref?.replace("refs/heads/", "") ?? "";
    const repoObj = payload.repository as Record<string, unknown> | undefined;
    const repo = (repoObj?.full_name as string | undefined) ?? "";

    // Check if this branch is a watched branch for the repo
    const watchedBranch = registeredRepos.get(repo);
    if (!watchedBranch || watchedBranch !== branch) {
      return reply.code(200).send({ ok: true, skipped: true, reason: "branch not watched" });
    }

    // Webhook = poll-now accelerator: trigger immediate poll tick
    pollNow("github");

    return reply.code(200).send({ ok: true, triggered_poll: true });
  });
}

// ------------------------------------------------------------------
// Backwards-compat shims (kept so any existing call sites compile)
// ------------------------------------------------------------------

/** @deprecated Use registerGithubPoller() + startAllPollers() instead. */
export function startGithubPollMode(): void {
  // No-op: startAllPollers() in index.ts boot handles this now.
}

/** @deprecated Use stopAllPollers() instead. */
export function stopGithubPollMode(): void {
  // No-op: stopAllPollers() in index.ts onClose handles this now.
}

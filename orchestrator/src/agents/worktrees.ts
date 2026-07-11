// Session worktrees — the "separate copy" flow. When a second agent session
// would collide with a live one in the same checkout, Flow can branch the
// user's own folder into an isolated git worktree and run the new session
// there, so the two never overwrite each other's working tree.
//
// This module is deliberately factored to make NO assumptions about running
// next to the graph: plain fs + git only, no db imports. On EC2 (Flow remote,
// agents local) this is the kind of thing that would run in the future local
// companion process on the user's machine — the one place that actually holds
// the user's checkout. Never assume a shared filesystem with the graph.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readdir, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// A worktree add on a big repo (and the overlay copies below) must never block
// the event loop, and must never hang a session start forever — hence async
// spawn everywhere with a generous 60s ceiling.
const GIT_TIMEOUT_MS = 60_000;
const CP_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  return execFileP("git", ["-C", cwd, ...args], { timeout, maxBuffer: MAX_BUFFER }).then((r) => r.stdout);
}

// True iff git resolves the ref (rev-parse --verify --quiet exits non-zero when
// it doesn't, which rejects the promise).
async function gitHas(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

// kebab from the first ~4 words of the title — the human-readable half of the
// branch/path. Empty/punctuation-only titles fall back to "task".
function slugifyTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  return words.join("-") || "task";
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

// Resolve the base ref to branch off, in preference order (each commented):
//   1. origin/<baseBranch> — the shared upstream tip is the truest "the branch"
//      when a remote exists.
//   2. <baseBranch>        — a local branch of that name, when there's no remote
//      tracking ref (fresh clone, offline, or renamed remote).
//   3. HEAD                — whatever the user's checkout is currently on, so a
//      separate copy is still possible even off an unregistered/detached base.
async function resolveBaseRef(srcCheckout: string, baseBranch: string): Promise<string> {
  if (await gitHas(srcCheckout, `origin/${baseBranch}^{commit}`)) return `origin/${baseBranch}`;
  if (await gitHas(srcCheckout, `${baseBranch}^{commit}`)) return baseBranch;
  return "HEAD";
}

// Find a `flow/<slug>-<rand>` branch name that doesn't already exist in the
// source checkout (git branch add refuses to reuse a name). Loop a few random
// suffixes, then fall back to a timestamp so we never spin forever.
async function uniqueBranch(srcCheckout: string, baseSlug: string): Promise<{ branch: string; slug: string }> {
  for (let i = 0; i < 25; i++) {
    const slug = `${baseSlug}-${randomSuffix()}`;
    const branch = `flow/${slug}`;
    if (!(await gitHas(srcCheckout, `refs/heads/${branch}`))) return { branch, slug };
  }
  const slug = `${baseSlug}-${Date.now().toString(36)}`;
  return { branch: `flow/${slug}`, slug };
}

// Copy every .env / .env.* file from the checkout root into the worktree.
//
// COPY, never symlink — this is load-bearing. An agent that edits its .env
// through a symlink would silently rewrite the user's ONE golden secrets file,
// and that change would leak into every other tree pointed at the same target.
// A copy is an independent snapshot: whatever the agent does to it, the blast
// radius stays inside this worktree.
async function overlayEnvFiles(srcCheckout: string, dest: string): Promise<void> {
  let names: string[];
  try {
    const entries = await readdir(srcCheckout, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && /^\.env(\..+)?$/.test(e.name)).map((e) => e.name);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      await copyFile(path.join(srcCheckout, name), path.join(dest, name));
    } catch (e) {
      console.warn(`[worktrees] failed to copy ${name} into worktree: ${(e as Error).message}`);
    }
  }
}

// Copy-on-write clone of node_modules — only when the checkout is actually a
// node project (package.json) AND has installed deps. CoW makes this cheap:
//   darwin: cp -c  (clonefile)      linux: cp --reflink=auto
// If the CoW attempt fails (unsupported fs, cross-device), we SKIP with a warn
// rather than fall back to a slow full recursive copy — a worktree must never
// block session start, and a missing node_modules is recoverable (npm install).
//
// Flutter/Gradle/CocoaPods caches are deliberately NOT copied in v1: they bake
// absolute paths, so a copied cache poisons the new tree and forces a partial
// rebuild anyway — no faster than a clean build, and riskier.
async function overlayNodeModules(srcCheckout: string, dest: string): Promise<void> {
  if (!existsSync(path.join(srcCheckout, "package.json"))) return;
  const nm = path.join(srcCheckout, "node_modules");
  if (!existsSync(nm)) return;
  const args =
    process.platform === "darwin"
      ? ["-c", "-R", nm, dest + path.sep] // clonefile CoW
      : ["-R", "--reflink=auto", nm, dest + path.sep]; // reflink where supported, else plain copy
  try {
    await execFileP("cp", args, { timeout: CP_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  } catch (e) {
    console.warn(`[worktrees] node_modules CoW clone failed, skipping: ${(e as Error).message}`);
  }
}

export interface CreateWorktreeResult {
  path: string;
  branch: string;
}

// Create an isolated worktree off the user's checkout and prepare it for a
// session. On any failure returns {error} — the caller must NOT silently fall
// back to running in place (that would defeat the whole point of "separate
// copy").
export async function createSessionWorktree(opts: {
  repoName: string;
  srcCheckout: string;
  baseBranch: string;
  title: string;
}): Promise<CreateWorktreeResult | { error: string }> {
  const { repoName, srcCheckout, baseBranch, title } = opts;
  try {
    if (!existsSync(srcCheckout)) return { error: `checkout not found: ${srcCheckout}` };

    // workspaceDir = dirname(REPOS_JSON_PATH) — the same convention
    // listRepoOptions() uses to locate Flow's managed repos dir. Worktrees live
    // alongside under <workspaceDir>/worktrees/<repoName>/<slug>.
    const reposJson = process.env.REPOS_JSON_PATH;
    if (!reposJson) return { error: "REPOS_JSON_PATH is not set — cannot place a worktree" };
    const workspaceDir = path.dirname(reposJson);

    const baseRef = await resolveBaseRef(srcCheckout, baseBranch);
    const { branch, slug } = await uniqueBranch(srcCheckout, slugifyTitle(title));

    const parent = path.join(workspaceDir, "worktrees", repoName);
    await mkdir(parent, { recursive: true });
    const dest = path.join(parent, slug);

    // Yes, this writes worktree metadata into the user's OWN checkout's .git —
    // that's the accepted price of "branch off my folder". The new tree shares
    // the object database, so base-scope diffs (merge-base against the base
    // branch) Just Work with no extra plumbing.
    await git(srcCheckout, ["worktree", "add", "-b", branch, dest, baseRef]);

    // Overlay pass: the gitignored files a working tree needs but the checkout
    // itself doesn't carry.
    await overlayEnvFiles(srcCheckout, dest);
    await overlayNodeModules(srcCheckout, dest);

    return { path: dest, branch };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string; // short name (refs/heads/ stripped)
  bare?: boolean;
  detached?: boolean;
  locked?: boolean;
}

// Parse `git worktree list --porcelain`: blank-line-separated blocks, each a
// `worktree <path>` line plus optional HEAD/branch/bare/detached/locked lines.
// Exported for Phase C; kept intentionally simple. Returns [] on any git error.
export async function listWorktrees(srcCheckout: string): Promise<WorktreeEntry[]> {
  let out: string;
  try {
    out = await git(srcCheckout, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  const flush = () => {
    if (cur) entries.push(cur);
    cur = null;
  };
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length) };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      cur.locked = true;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return entries;
}

// ===========================================================================
// Phase C — visibility + exits for the separate copies. Everything below is
// still pure git+fs (no db, no registry imports): the caller in runtime.ts
// supplies the src checkout, base branch, and GitHub owner/repo. That keeps
// this module runnable in the future local companion process, where the
// user's checkout actually lives — the graph (and its db) may be remote.
// ===========================================================================

// The flow-managed worktrees root: dirname(REPOS_JSON_PATH)/worktrees. Every
// separate copy lives under here; anything outside is off-limits to the
// remove/apply machinery below — Flow must NEVER git-remove or merge a path it
// didn't create just because a client passed it.
export function managedWorktreesRoot(): string | null {
  const reposJson = process.env.REPOS_JSON_PATH;
  if (!reposJson) return null;
  return path.join(path.dirname(reposJson), "worktrees");
}

// realpath when the path exists (macOS /var → /private/var), else the path
// verbatim. Both sides of every managed-dir / session-attachment comparison
// pass through here so symlinked temp dirs don't cause false mismatches.
export function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// True iff `p` sits strictly inside the managed worktrees root. Checked against
// both the raw root and its realpath so a realpath'd tree path (what
// `git worktree list` emits) still matches a raw root (what REPOS_JSON_PATH
// yields) on symlinked filesystems.
export function isManagedWorktree(p: string): boolean {
  const root = managedWorktreesRoot();
  if (!root) return false;
  const real = realpathOrSelf(p);
  for (const base of new Set([root, realpathOrSelf(root)])) {
    for (const candidate of new Set([p, real])) {
      const rel = path.relative(base, candidate);
      if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
    }
  }
  return false;
}

// The repo name that owns a managed tree — the first path segment under the
// managed root (<root>/<repo>/<slug>). null when the path isn't managed.
export function managedRepoOf(p: string): string | null {
  const root = managedWorktreesRoot();
  if (!root) return null;
  const real = realpathOrSelf(p);
  for (const base of new Set([root, realpathOrSelf(root)])) {
    for (const candidate of new Set([p, real])) {
      const rel = path.relative(base, candidate);
      if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel.split(path.sep)[0] || null;
      }
    }
  }
  return null;
}

// First non-empty line of a git failure — prefer captured stderr (execFile
// puts it on .stderr), fall back to the wrapped message. The honest one-liner
// we surface to the UI verbatim.
function gitErrLine(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const text = (err.stderr && err.stderr.trim()) || err.message || String(e);
  return text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? text;
}

// True iff git exits 0 for `args` (probe commands whose signal is the exit
// code, e.g. merge-base --is-ancestor).
async function gitExit0(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

// Resolve the base branch to a ref that exists in the TREE (which shares the
// object db with its source checkout): origin/<base> if a remote tracks it,
// else a local <base>, else null (no base to compare against).
export async function resolveBaseInTree(treePath: string, baseBranch: string): Promise<string | null> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    if (await gitHas(treePath, `${ref}^{commit}`)) return ref;
  }
  return null;
}

// Uncommitted work in a checkout (staged, unstaged, or untracked). On a git
// error we say "not dirty" — the actual mutating op (worktree remove / merge)
// is the final judge and refuses on its own if the tree is really dirty.
export async function isDirty(checkout: string): Promise<boolean> {
  try {
    return (await git(checkout, ["status", "--porcelain"])).trim().length > 0;
  } catch {
    return false;
  }
}

export interface WorktreeInspect {
  branch: string | null;
  base: string; // the registry branch name (echoed for the UI)
  aheadCount: number;
  dirty: boolean;
  merged: boolean; // HEAD is an ancestor of base ⇒ fully landed in base
  health: "ok" | "broken";
}

// The git-derived facts about one separate copy. "broken" = the path is gone
// or git can't read it (a partial/corrupt tree the user should just clean up);
// aheadCount degrades to 0 so a broken row never looks like "work to lose".
export async function inspectWorktree(opts: {
  treePath: string;
  baseBranch: string;
  branch?: string; // from `git worktree list` porcelain, when already known
}): Promise<WorktreeInspect> {
  const base = opts.baseBranch;
  const broken: WorktreeInspect = {
    branch: opts.branch ?? null,
    base,
    aheadCount: 0,
    dirty: false,
    merged: false,
    health: "broken",
  };
  if (!existsSync(opts.treePath)) return broken;
  try {
    const baseRef = await resolveBaseInTree(opts.treePath, base);
    const branch = opts.branch ?? ((await git(opts.treePath, ["branch", "--show-current"])).trim() || null);
    const dirty = (await git(opts.treePath, ["status", "--porcelain"])).trim().length > 0;
    let aheadCount = 0;
    let merged = false;
    if (baseRef) {
      try {
        const n = parseInt((await git(opts.treePath, ["rev-list", "--count", `${baseRef}..HEAD`])).trim(), 10);
        aheadCount = Number.isFinite(n) ? n : 0;
      } catch {
        aheadCount = 0;
      }
      merged = await gitExit0(opts.treePath, ["merge-base", "--is-ancestor", "HEAD", baseRef]);
    }
    return { branch, base, aheadCount, dirty, merged, health: "ok" };
  } catch {
    return broken;
  }
}

// Remove a separate copy. `git worktree remove` runs from the SOURCE checkout
// (which owns the worktree metadata), then the flow/ branch is deleted (-d, or
// -D under force). Guarded: refuses paths outside the managed root, and refuses
// a dirty tree unless forced. A missing folder is a no-op prune (the common
// "broken" case). The caller (runtime) additionally refuses while a LIVE
// session is still attached — that needs the session map, which lives there.
export async function removeWorktree(opts: {
  srcCheckout: string;
  treePath: string;
  branch?: string | null;
  force?: boolean;
}): Promise<{ ok: true } | { error: string }> {
  const { srcCheckout, treePath, branch, force } = opts;
  if (!isManagedWorktree(treePath)) return { error: "That path isn't a Flow-managed copy." };

  // Folder already gone (deleted out from under us) — prune the dangling
  // metadata and drop the branch; there's no working tree left to remove.
  if (!existsSync(treePath)) {
    try {
      await git(srcCheckout, ["worktree", "prune"]);
    } catch {
      /* best-effort */
    }
    if (branch) {
      try {
        await git(srcCheckout, ["branch", "-D", branch]);
      } catch {
        /* branch may already be gone */
      }
    }
    return { ok: true };
  }

  if (!force && (await isDirty(treePath))) {
    return { error: "This copy has uncommitted changes. Remove anyway?" };
  }

  try {
    const args = ["worktree", "remove", treePath];
    if (force) args.push("--force");
    await git(srcCheckout, args);
  } catch (e) {
    return { error: gitErrLine(e) };
  }
  if (branch) {
    // A separate copy's branch has no life after its tree. -d is the safe
    // default (refuses unmerged); -D under force. A failure here isn't fatal —
    // the tree is already gone, and a leftover branch is harmless.
    try {
      await git(srcCheckout, ["branch", force ? "-D" : "-d", branch]);
    } catch {
      /* leave the branch; not worth failing the remove over */
    }
  }
  return { ok: true };
}

// ⚠️ THE ONE ACTION THAT WRITES TO THE USER'S OWN CHECKOUT. Merges the separate
// copy's branch back into whatever branch the user's folder is currently on.
// Guarded hard and made reversible: guards run in order, each with its own
// honest message, and ANY merge failure is immediately `merge --abort`-ed so
// the user's folder is left byte-for-byte as we found it.
export async function applyWorktree(opts: {
  srcCheckout: string;
  treePath: string;
  branch: string;
}): Promise<{ ok: true; mergedInto: string } | { error: string }> {
  const { srcCheckout, treePath, branch } = opts;
  if (!isManagedWorktree(treePath)) return { error: "That path isn't a Flow-managed copy." };
  // Guard 1 — the copy must be clean: `git merge` takes the committed branch
  // tip, so uncommitted work in the copy would be silently left behind.
  if (await isDirty(treePath)) return { error: "Commit or discard changes in the copy first." };
  // Guard 2 — the user's folder must be clean: a merge into a dirty tree can
  // fail partway and tangle their in-progress work with ours.
  if (await isDirty(srcCheckout)) {
    return { error: "Your folder has uncommitted changes — stash or commit them first." };
  }
  const mergedInto = (await git(srcCheckout, ["branch", "--show-current"])).trim() || "HEAD";
  try {
    await git(srcCheckout, ["merge", "--no-ff", branch]);
  } catch {
    // Roll the user's folder back to exactly where it was before the attempt.
    await git(srcCheckout, ["merge", "--abort"]).catch(() => {});
    return { error: "That copy doesn't merge cleanly — review the diff and merge it manually." };
  }
  return { ok: true, mergedInto };
}

// Legacy helper: push a copy's branch to origin using the user's AMBIENT git credentials.
// Deliberately NO token injection into the remote here — this is an interactive
// push the user initiated, not the indexer's background fetch. owner/repo come
// from the registry url (parsed by the caller) so we can build the compare URL.
export async function pushWorktree(opts: {
  treePath: string;
  branch: string;
  base: string;
  owner: string;
  repo: string;
}): Promise<{ ok: true; compareUrl: string } | { error: string }> {
  const { treePath, branch, base, owner, repo } = opts;
  try {
    await git(treePath, ["push", "-u", "origin", branch]);
  } catch (e) {
    return { error: gitErrLine(e) };
  }
  // Encode each path segment but KEEP the slashes — a GitHub compare URL uses
  // the literal branch name (flow/foo), so `/` must survive.
  const enc = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");
  const compareUrl = `https://github.com/${owner}/${repo}/compare/${enc(base)}...${enc(branch)}`;
  return { ok: true, compareUrl };
}

export interface OpenPullRequestResult {
  ok: true;
  compareUrl: string;
  branch: string;
  targetBranch: string;
  committed: boolean;
}

export interface OpenPullRequestConflict {
  conflict: true;
  branch: string;
  targetBranch: string;
  files: string[];
}

async function commitDirtyWorktree(treePath: string): Promise<boolean> {
  if (!(await isDirty(treePath))) return false;
  await git(treePath, ["add", "-A"]);
  const staged = (await git(treePath, ["diff", "--cached", "--name-only"])).trim();
  if (!staged) return false;
  await git(treePath, ["commit", "-m", "Flow agent changes"]);
  return true;
}

async function fetchTargetBranch(treePath: string, targetBranch: string): Promise<string | { error: string }> {
  try {
    await git(treePath, ["fetch", "origin", `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`]);
    return `origin/${targetBranch}`;
  } catch (e) {
    return { error: `Couldn't find target branch "${targetBranch}" on origin: ${gitErrLine(e)}` };
  }
}

function parseConflictFiles(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^CONFLICT\b/.test(line) || /^Auto-merging\b/.test(line) || /^[a-f0-9]{40}$/.test(line)) continue;
    if (/^[\w.-]+\s+/.test(line) && line.includes("\t")) {
      const parts = line.split("\t");
      if (parts[parts.length - 1]) out.add(parts[parts.length - 1]);
      continue;
    }
    if (!line.includes(":")) out.add(line);
  }
  return [...out].slice(0, 20);
}

async function mergeConflicts(
  treePath: string,
  targetRef: string
): Promise<{ conflict: false } | { conflict: true; files: string[] } | { error: string }> {
  try {
    await git(treePath, ["merge-tree", "--write-tree", targetRef, "HEAD"]);
    return { conflict: false };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const text = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
    if (!/CONFLICT\b|conflict/i.test(text)) return { error: gitErrLine(e) };
    let files = parseConflictFiles(text);
    try {
      await execFileP("git", ["-C", treePath, "merge-tree", "--write-tree", "--name-only", targetRef, "HEAD"], {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
    } catch (nameOnlyErr) {
      const ne = nameOnlyErr as { stdout?: string; stderr?: string; message?: string };
      const parsed = parseConflictFiles([ne.stdout, ne.stderr, ne.message].filter(Boolean).join("\n"));
      if (parsed.length) files = parsed;
    }
    return { conflict: true, files };
  }
}

// PR-first exit for a separate copy:
//   1. package dirty work into a commit so GitHub has an actual diff,
//   2. check mergeability against the chosen target branch,
//   3. push the exact local HEAD to origin/branch and verify it exists,
//   4. return the GitHub compare URL that opens the PR flow.
export async function openPullRequestWorktree(opts: {
  treePath: string;
  branch: string;
  targetBranch: string;
  owner: string;
  repo: string;
}): Promise<OpenPullRequestResult | OpenPullRequestConflict | { error: string }> {
  const { treePath, branch, targetBranch, owner, repo } = opts;
  if (!isManagedWorktree(treePath)) return { error: "That path isn't a Flow-managed copy." };
  if (!targetBranch.trim()) return { error: "Choose a target branch." };

  let committed = false;
  try {
    committed = await commitDirtyWorktree(treePath);
  } catch (e) {
    return { error: `Couldn't commit this copy's changes: ${gitErrLine(e)}` };
  }

  const targetRef = await fetchTargetBranch(treePath, targetBranch);
  if (typeof targetRef !== "string") return targetRef;

  const ahead = parseInt((await git(treePath, ["rev-list", "--count", `${targetRef}..HEAD`])).trim(), 10);
  if (!Number.isFinite(ahead) || ahead === 0) {
    return { error: `No changes to open a PR against ${targetBranch}.` };
  }

  const conflicts = await mergeConflicts(treePath, targetRef);
  if ("error" in conflicts) return { error: conflicts.error };
  if (conflicts.conflict) {
    return { conflict: true, branch, targetBranch, files: conflicts.files };
  }

  try {
    await git(treePath, ["push", "-u", "origin", `HEAD:refs/heads/${branch}`]);
    const remoteRef = (await git(treePath, ["ls-remote", "--heads", "origin", branch])).trim();
    if (!remoteRef) return { error: `Pushed, but origin/${branch} was not found afterwards.` };
  } catch (e) {
    return { error: gitErrLine(e) };
  }

  const enc = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");
  const compareUrl = `https://github.com/${owner}/${repo}/compare/${enc(targetBranch)}...${enc(branch)}?expand=1`;
  return { ok: true, compareUrl, branch, targetBranch, committed };
}

// Cheap hygiene before listing: drop dangling worktree metadata (folders the
// user deleted by hand). Best-effort — a prune failure never blocks a list.
export async function pruneWorktrees(srcCheckout: string): Promise<void> {
  try {
    await git(srcCheckout, ["worktree", "prune"]);
  } catch {
    /* best-effort */
  }
}

// sources.ts — the "sources front door".
//
// Users add a source by pasting ONE box: either a GitHub URL or a local
// filesystem path. The server inspects and classifies it, then the dashboard
// confirms what to connect. Every source plays up to two roles: BRAIN (indexed
// into the knowledge graph) and WORK (where coding-agent sessions run). For a
// code repo the BRAIN is ALWAYS the GitHub base branch via Flow's managed
// clone under repos/<name>; the WORK surface is the user's own local checkout
// when they have one.
//
// Local paths are LOCAL-MODE ONLY. In "prod" mode the server refuses path
// inspection before it ever touches the filesystem (a remote Flow has no
// access to the user's disk). Mode is read from project.json (what
// `flow project create --mode` writes), falling back to FLOW_MODE, default
// "local".
//
// inspectSource() never mutates anything and never logs the GitHub token.
// Route errors are returned as {error: string}, not thrown to the client.

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import path from "node:path";
import db from "./db.js";
import { getSetting } from "./settings.js";
import { getFlowMode, type FlowMode } from "./mode.js";
import {
  connectGithubRepo,
  enqueueJob,
  listWorkspaceRepos,
  registerSource,
} from "./opencode.js";

// ------------------------------------------------------------------
// Classification result shapes (these are also the /inspect response types)
// ------------------------------------------------------------------

export type SourceKind =
  | "github_url"
  | "git_repo"
  | "git_repo_local_only"
  | "folder"
  | "container"
  | "unsupported";

// A repo's on-disk facts, shared by git_repo / git_repo_local_only / container
// children.
export interface RepoShape {
  path: string;
  name: string;
  remoteUrl: string | null;   // normalized (no .git); null for a no-remote repo
  defaultBranch: string;
  currentBranch: string;
  dirty: boolean;             // uncommitted changes present
  alreadyConnected: boolean;  // name already in the registry
}

// Docs-source stats — junk-defended file counts for a plain folder (or the
// carve-out remainder of a container).
export interface DocsShape {
  path: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  skipped: { hidden: number; deps: number; oversize: number; binary: number };
  truncated: boolean;         // walk hit the file cap
}

export interface GithubUrlResult {
  kind: "github_url";
  // Nested (not flat) — this is the exact shape the dashboard's AddSource
  // component consumes as `result.github`.
  github: {
    url: string;
    owner: string;
    name: string;
    defaultBranch: string;
    alreadyConnected: boolean;
  };
}

export interface GitRepoResult {
  kind: "git_repo" | "git_repo_local_only";
  repo: RepoShape;
}

export interface FolderResult {
  kind: "folder";
  docs: DocsShape;
}

export interface ContainerChildRepo extends RepoShape {
  thirdParty: boolean;    // path passes through vendor/ third_party/ deps/ packages/vendor
  checkedDefault: boolean; // pre-checked in the UI (= !thirdParty)
}

export interface ContainerResult {
  kind: "container";
  children: {
    repos: ContainerChildRepo[];
    docs: DocsShape; // everything NOT inside a found repo subtree (the carve-out)
  };
}

export interface UnsupportedResult {
  kind: "unsupported";
  // Named `error` because the dashboard renders it verbatim in the
  // "Not something Flow can take on" card.
  error: string;
}

export type InspectResult =
  | GithubUrlResult
  | GitRepoResult
  | FolderResult
  | ContainerResult
  | UnsupportedResult;

// ------------------------------------------------------------------
// Junk-defense constants (shared by the docs walk and the repo scan)
// ------------------------------------------------------------------

// Dependency / build / cache dirs we never descend into or count.
const DEP_DIRS = new Set([
  "node_modules", "build", "dist", "out", ".next", ".venv", "venv", "Pods",
  ".dart_tool", ".gradle", "target", "__pycache__", ".terraform", "coverage",
]);

// Extensions we KEEP as ingestable docs; everything else is counted as binary.
const KEEP_EXT = new Set([
  "md", "txt", "markdown", "pdf", "docx", "doc", "rtf", "csv", "tsv", "json",
  "yaml", "yml", "html", "htm", "png", "jpg", "jpeg", "gif", "webp", "svg",
]);

const MAX_FILE_BYTES = 25 * 1024 * 1024; // files larger than this are "oversize"
const WALK_CAP = 20_000;                  // bound the docs walk
const REPO_SCAN_DEPTH = 3;                // container: find repos within depth 3

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

// Async git so a slow disk never blocks the event loop. Non-zero exit is a
// normal answer (e.g. no origin remote) — we return ok=false with empty out.
function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, out: (stdout ?? "").trim() }),
    );
  });
}

// owner/name + canonical https URL from any GitHub URL form (https/ssh, with
// or without .git). null when it isn't a GitHub URL.
function parseGithubUrl(input: string): { owner: string; name: string; url: string } | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(input.trim());
  if (!m) return null;
  return { owner: m[1], name: m[2], url: `https://github.com/${m[1]}/${m[2]}` };
}

// Normalize a remote for display: canonicalize GitHub to https (no .git),
// otherwise just strip a trailing .git.
function normalizeRemote(raw: string): string {
  const gh = parseGithubUrl(raw);
  return gh ? gh.url : raw.replace(/\.git$/, "");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isRegistered(name: string): boolean {
  return listWorkspaceRepos().some((r) => r.name === name);
}

// Project mode: prefer project.json (what `flow project create --mode` writes,
// same file projectGraphName() reads), fall back to FLOW_MODE / "local".
function projectMode(): FlowMode {
  if (process.env.DB_PATH && process.env.DB_PATH !== ":memory:") {
    try {
      const pj = JSON.parse(
        readFileSync(join(path.dirname(process.env.DB_PATH), "project.json"), "utf8"),
      ) as { mode?: string };
      if (pj.mode === "prod" || pj.mode === "local") return pj.mode;
    } catch {
      /* fall through to env/default */
    }
  }
  return getFlowMode();
}

// GitHub default branch via the REST API. Bearer the GITHUB_TOKEN when set;
// any failure (network, 404 on a private repo without a token, rate limit)
// falls back to "main". The token is never logged.
async function githubDefaultBranch(owner: string, name: string): Promise<string> {
  try {
    const token = getSetting("GITHUB_TOKEN");
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return "main";
    const j = (await res.json()) as { default_branch?: string };
    return j.default_branch || "main";
  } catch {
    return "main";
  }
}

// ------------------------------------------------------------------
// Docs walk — junk-defended file/byte counts, with an optional carve-out set
// of subtree roots to exclude (the found repos inside a container).
// ------------------------------------------------------------------

function walkDocs(root: string, excludeDirs: Set<string> = new Set()): DocsShape {
  const skipped = { hidden: 0, deps: 0, oversize: 0, binary: 0 };
  let fileCount = 0;
  let totalBytes = 0;
  let visited = 0;
  let truncated = false;

  const stack: string[] = [root];
  while (stack.length && !truncated) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (excludeDirs.has(full)) continue;                 // carve-out: a repo subtree
      if (ent.name.startsWith(".")) { skipped.hidden++; continue; }
      if (ent.isDirectory()) {
        if (DEP_DIRS.has(ent.name)) { skipped.deps++; continue; }
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;                         // symlinks, sockets, …
      if (visited >= WALK_CAP) { truncated = true; break; }
      visited++;
      const dot = ent.name.lastIndexOf(".");
      const ext = dot > 0 ? ent.name.slice(dot + 1).toLowerCase() : "";
      if (!KEEP_EXT.has(ext)) { skipped.binary++; continue; }
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      if (size > MAX_FILE_BYTES) { skipped.oversize++; continue; }
      fileCount++;
      totalBytes += size;
    }
  }
  return { path: root, name: basename(root), fileCount, totalBytes, skipped, truncated };
}

// ------------------------------------------------------------------
// Nested-repo scan for container detection — find git repos within depth 3,
// skipping junk dirs, not descending INTO a found repo (no nested-repo-inside-
// repo discovery in v1). Separates real repos (.git DIRECTORY) from foreign
// checkouts (.git FILE = submodule/worktree), which we note and skip.
// ------------------------------------------------------------------

function findNestedRepos(root: string): { repos: string[]; foreign: string[] } {
  const repos: string[] = [];
  const foreign: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Is this dir itself a repo? (root is known NOT to be one — caller checked.)
    if (dir !== root) {
      const gitEnt = entries.find((e) => e.name === ".git");
      if (gitEnt) {
        if (gitEnt.isDirectory()) repos.push(dir);
        else foreign.push(dir); // .git file → submodule/foreign-worktree
        continue;               // never descend into a repo
      }
    }
    if (depth >= REPO_SCAN_DEPTH) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (DEP_DIRS.has(e.name)) continue;
      queue.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
  }
  return { repos, foreign };
}

// A container child is third-party when its path relative to the container
// passes through vendor/, third_party/, deps/, or packages/vendor.
function isThirdPartyPath(rel: string): boolean {
  const parts = rel.split(/[/\\]/);
  for (const seg of parts) {
    if (seg === "vendor" || seg === "third_party" || seg === "deps") return true;
  }
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === "packages" && parts[i + 1] === "vendor") return true;
  }
  return false;
}

// ------------------------------------------------------------------
// Per-kind inspectors
// ------------------------------------------------------------------

async function inspectGitRepo(repoPath: string): Promise<GitRepoResult> {
  const name = basename(repoPath);
  const remoteRes = await git(repoPath, ["remote", "get-url", "origin"]);
  const remoteRaw = remoteRes.ok ? remoteRes.out : "";
  const isGithub = remoteRaw ? /github\.com[/:]/i.test(remoteRaw) : false;
  const remoteUrl = remoteRaw ? normalizeRemote(remoteRaw) : null;

  // Default branch: origin/HEAD's target, else the current branch, else main.
  const sym = await git(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const currentBranch = (await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).out || "";
  let defaultBranch = sym.ok ? sym.out.replace(/^refs\/remotes\/origin\//, "") : "";
  if (!defaultBranch) defaultBranch = currentBranch || "main";

  const dirty = (await git(repoPath, ["status", "--porcelain"])).out.length > 0;

  const repo: RepoShape = {
    path: repoPath,
    name,
    remoteUrl,
    defaultBranch,
    currentBranch,
    dirty,
    alreadyConnected: isRegistered(name),
  };
  // A GitHub remote → git_repo (has a BRAIN via the managed clone). No remote,
  // or a non-GitHub remote → local_only tier (we keep remoteUrl for display).
  return { kind: isGithub ? "git_repo" : "git_repo_local_only", repo };
}

async function inspectContainer(containerPath: string, repoPaths: string[]): Promise<ContainerResult> {
  const repos: ContainerChildRepo[] = [];
  for (const rp of repoPaths) {
    const { repo } = await inspectGitRepo(rp);
    const thirdParty = isThirdPartyPath(relative(containerPath, rp));
    repos.push({ ...repo, thirdParty, checkedDefault: !thirdParty });
  }
  // Docs = everything in the container EXCLUDING the found repo subtrees.
  const docs = walkDocs(containerPath, new Set(repoPaths));
  return { kind: "container", children: { repos, docs } };
}

async function inspectPath(abs: string): Promise<InspectResult> {
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`No such folder: ${abs}`);
  }
  if (!st.isDirectory()) {
    return { kind: "unsupported", error: `"${abs}" is a file, not a folder — connect a repository or a docs folder.` };
  }

  const dotGit = join(abs, ".git");
  let gitStat: ReturnType<typeof statSync> | null = null;
  try {
    if (existsSync(dotGit)) gitStat = statSync(dotGit);
  } catch {
    gitStat = null;
  }

  // .git FILE = submodule / linked worktree → unsupported at top level.
  if (gitStat?.isFile()) {
    return {
      kind: "unsupported",
      error: "This folder is a git submodule or linked worktree (its .git is a file, not a repo) — connect the parent repository instead.",
    };
  }

  // A real repo wins over container semantics (no scanning inside repos in v1).
  if (gitStat?.isDirectory()) return inspectGitRepo(abs);

  // Not a repo itself → container (repos nested within) or a plain docs folder.
  const { repos } = findNestedRepos(abs);
  if (repos.length > 0) return inspectContainer(abs, repos);
  return { kind: "folder", docs: walkDocs(abs) };
}

// ------------------------------------------------------------------
// Public: classify one pasted input.
// Throws Error for prod-mode refusal and unusable input; the routes convert
// those to {error}. `unsupported` is a normal (200) classification, not an error.
// ------------------------------------------------------------------

export async function inspectSource(input: string): Promise<InspectResult> {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new Error("Enter a GitHub URL or a local folder path.");

  // GitHub URL — only when the input isn't shaped like a filesystem path (so a
  // path that happens to end in github.com/x/y is still treated as a path).
  const looksLikePath = /^[~./\\]/.test(trimmed);
  if (!looksLikePath) {
    const gh = parseGithubUrl(trimmed);
    if (gh) {
      return {
        kind: "github_url",
        github: {
          url: gh.url,
          owner: gh.owner,
          name: gh.name,
          defaultBranch: await githubDefaultBranch(gh.owner, gh.name),
          alreadyConnected: isRegistered(gh.name),
        },
      };
    }
    throw new Error(`"${trimmed.slice(0, 80)}" isn't a GitHub URL or an absolute local path.`);
  }

  // Local path — refuse in prod BEFORE touching the filesystem.
  if (projectMode() === "prod") {
    throw new Error("local paths aren't available on a remote Flow — connect GitHub repos or upload files");
  }

  const expanded = expandHome(trimmed);
  if (!isAbsolute(expanded)) {
    throw new Error(`"${trimmed}" is not an absolute path — paste a full path like /Users/you/project.`);
  }
  if (!existsSync(expanded)) throw new Error(`No such folder: ${expanded}`);
  return inspectPath(expanded);
}

// ------------------------------------------------------------------
// /add — the confirmed connect. Each item is already-classified by the client;
// we re-validate prod-mode for anything carrying a local path.
// ------------------------------------------------------------------

export interface AddRepoSource {
  type: "repo";
  url?: string | null;
  localPath?: string | null;
  branch: string;
  name: string;
}

export interface AddDocsSource {
  type: "docs";
  path: string;
  name: string;
}

export type AddSource = AddRepoSource | AddDocsSource;

export interface AddResult {
  added: Array<{ name: string; kind: "code" | "docs"; jobId?: string }>;
  errors: Array<{ name: string; error: string }>;
}

// Audit one connected source. No originating event, so we correlate the rows
// with a synthetic id (kept in event_id) rather than leaving it null.
function auditSource(action: string, name: string, detail: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail)
     VALUES (?, 'source_added', 1.0, ?, ?, 'ok', ?)`,
  ).run(randomUUID(), action, name, JSON.stringify(detail));
}

export async function addSources(sources: AddSource[]): Promise<AddResult> {
  const out: AddResult = { added: [], errors: [] };
  const prod = projectMode() === "prod";

  for (const src of sources) {
    const name = (src as { name?: string }).name ?? "(unnamed)";
    try {
      if (src.type === "docs") {
        // Docs always live on the local filesystem.
        if (prod) throw new Error("local paths aren't available on a remote Flow — connect GitHub repos or upload files");
        if (!src.path || !src.name) throw new Error("docs source needs a name and a path");
        registerSource({ kind: "docs", name: src.name, path: src.path, status: "pending_ingestion" });
        auditSource("docs_registered", src.name, { path: src.path });
        out.added.push({ name: src.name, kind: "docs" });
        continue;
      }

      if (src.type === "repo") {
        if (!src.name || !src.branch) throw new Error("repo source needs a name and a branch");
        const url = src.url ?? "";
        const localPath = src.localPath ?? "";
        if (localPath && prod) {
          throw new Error("local paths aren't available on a remote Flow — connect GitHub repos or upload files");
        }

        if (url) {
          // GitHub repo — BRAIN is Flow's managed clone; localPath (if any) is
          // the WORK surface. Same path the dashboard repo_added button uses.
          const { entry, jobId } = await connectGithubRepo(url, src.branch, localPath || undefined);
          auditSource("index_job", entry.name, { job: jobId, branch: entry.branch, url });
          out.added.push({ name: entry.name, kind: "code", jobId });
          continue;
        }

        if (localPath) {
          // Local-only (no remote) repo — index in place from the user's
          // folder (the local tier). runJob's ensureRepoClone resolves the
          // localPath from the registry.
          registerSource({ kind: "code", name: src.name, url: "", localPath, branch: src.branch });
          const job = await enqueueJob({
            type: "index_repo",
            input: { repo: src.name, branch: src.branch },
            repo: src.name,
          });
          auditSource("index_job", src.name, { job: job.id, branch: src.branch, localPath: true });
          out.added.push({ name: src.name, kind: "code", jobId: job.id });
          continue;
        }

        throw new Error("repo source needs a url or a localPath");
      }

      throw new Error(`unknown source type "${(src as { type?: string }).type}"`);
    } catch (err) {
      out.errors.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Routes — same bearer auth as every other /v1 route (the global onRequest
// hook). Errors are {error} bodies, never thrown to the client.
// ------------------------------------------------------------------

export function registerSourceRoutes(app: FastifyInstance): void {
  // POST /v1/sources/inspect {input} → classification (or {error})
  app.post("/v1/sources/inspect", async (req, reply) => {
    const { input } = (req.body ?? {}) as { input?: string };
    if (typeof input !== "string" || input.trim().length === 0) {
      return reply.code(400).send({ error: "input is required" });
    }
    try {
      return reply.send(await inspectSource(input));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /v1/sources/add {sources: [...]} → {added, errors}
  app.post("/v1/sources/add", async (req, reply) => {
    const { sources } = (req.body ?? {}) as { sources?: unknown };
    if (!Array.isArray(sources) || sources.length === 0) {
      return reply.code(400).send({ error: "sources must be a non-empty array" });
    }
    return reply.send(await addSources(sources as AddSource[]));
  });
}

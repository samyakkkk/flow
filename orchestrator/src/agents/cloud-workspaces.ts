import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import db from "../db.js";
import { createSessionWorktree, overlayEnvFiles } from "./worktrees.js";
import { applyRepoEnv } from "./repo-env.js";

const exec = promisify(execFile);

export interface ConversationRef {
  source: string;
  id: string;
  workspace?: string;
}

export interface CloudRepo {
  name: string;
  source: string;
  baseBranch: string;
  worktree?: { path: string; branch: string; base_commit: string; git_dir?: string | null; git_identity?: string | null; archived_at?: number | null; checkpoint_commit?: string | null; cleanup_error?: string | null };
}

export function cloudMode(): boolean {
  return process.env.FLOW_MODE === "prod";
}

export function cloudTaskTimeoutMs(): number {
  const value = Number(process.env.FLOW_CLOUD_TASK_TIMEOUT_MS ?? 3_600_000);
  return Number.isFinite(value) && value > 0 && value <= 2_147_483_647 ? value : 3_600_000;
}

export function conversationKey(ref: ConversationRef): string {
  if (!ref || typeof ref.source !== "string" || !ref.source.trim() ||
      typeof ref.id !== "string" || !ref.id.trim() ||
      (ref.workspace !== undefined && typeof ref.workspace !== "string")) {
    throw new Error("conversation requires source, id, and an optional workspace");
  }
  return JSON.stringify([ref.source, ref.workspace ?? "", ref.id]);
}

export function slackConversation(workspace: string, channel: string, thread: string): ConversationRef {
  return { source: "slack", workspace, id: JSON.stringify([channel, thread]) };
}

export function cloudWorkspaceDir(): string {
  return path.resolve(process.env.OPENCODE_WORKSPACE_DIR ??
    (process.env.REPOS_JSON_PATH ? path.dirname(process.env.REPOS_JSON_PATH) :
      fileURLToPath(new URL("../../../index-workspace", import.meta.url))));
}

export function ensureConversation(key: string): void {
  db.prepare("INSERT OR IGNORE INTO cloud_conversations (conversation_key) VALUES (?)").run(key);
}

export function hasConversation(ref: ConversationRef): boolean {
  return Boolean(db.prepare("SELECT 1 FROM cloud_conversations WHERE conversation_key = ?").get(conversationKey(ref)));
}

export function conversationSession(key: string): string | undefined {
  return (db.prepare("SELECT session_id FROM cloud_conversations WHERE conversation_key = ?").get(key) as
    { session_id?: string } | undefined)?.session_id || undefined;
}

export function bindConversation(key: string, sessionId: string): void {
  db.prepare("UPDATE cloud_conversations SET session_id = ?, updated_at = unixepoch() WHERE conversation_key = ?")
    .run(sessionId, key);
}

export function conversationRepos(key: string): CloudRepo[] {
  const workspace = cloudWorkspaceDir();
  const registry = JSON.parse(readFileSync(path.join(workspace, "repos.json"), "utf8")) as {
    repos: Array<{ name: string; branch: string; kind?: string }>;
  };
  return registry.repos.filter((r) => r.kind !== "docs").map((repo) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(repo.name) || repo.name === "." || repo.name === "..") {
      throw new Error(`Invalid registered repo name: ${repo.name}`);
    }
    const worktree = db.prepare(
      "SELECT path, branch, base_commit, git_dir, git_identity, archived_at, checkpoint_commit, cleanup_error FROM cloud_worktrees WHERE conversation_key = ? AND repo = ?",
    ).get(key, repo.name) as CloudRepo["worktree"];
    return { name: repo.name, source: path.join(workspace, "repos", repo.name), baseBranch: repo.branch, worktree };
  });
}

// One orchestrator owns a project DB. Serialize creation so parallel tool calls
// cannot allocate two branches for the same conversation/repo.
const creating = new Map<string, Promise<CloudRepo>>();

export async function ensureConversationWorktree(key: string, name: string, refreshEnv = false): Promise<CloudRepo> {
  if (!cloudMode()) throw new Error("Cloud workspaces require FLOW_MODE=prod");
  const lock = JSON.stringify([key, name]);
  const existing = creating.get(lock);
  if (existing) return existing;
  const pending = create();
  creating.set(lock, pending);
  try {
    return await pending;
  } finally {
    creating.delete(lock);
  }

  async function create(): Promise<CloudRepo> {
    const repo = conversationRepos(key).find((r) => r.name === name);
    if (!repo) throw new Error(`Unknown code repo "${name}"; connect it first`);
    if (repo.worktree) {
      let restored = false;
      if (repo.worktree.archived_at && !existsSync(repo.worktree.path)) {
        const tip = await cloudGit(repo.source, ["rev-parse", `refs/heads/${repo.worktree.branch}^{commit}`]);
        if (tip !== repo.worktree.checkpoint_commit) throw new Error("Retained branch changed; refusing to restore a different checkpoint");
        await cloudGit(repo.source, ["worktree", "add", repo.worktree.path, repo.worktree.branch]);
        const restoredDir = await cloudGit(repo.worktree.path, ["rev-parse", "--absolute-git-dir"]);
        if (repo.worktree.git_identity) writeFileSync(path.join(restoredDir, "flow-task-identity"), repo.worktree.git_identity, { mode: 0o600 });
        await overlayEnvFiles(repo.source, repo.worktree.path);
        // git worktree add allocates a new metadata identity.
        repo.worktree.git_dir = null;
        db.prepare("UPDATE cloud_worktrees SET git_dir = NULL WHERE conversation_key = ? AND repo = ?").run(key, name);
        restored = true;
      }
      await reconcileWorktree(key, repo);
      if (restored || refreshEnv) applyRepoEnv(name, repo.source, repo.worktree.path, repo.worktree.git_dir!);
      return repo;
    }
    let commit: string | undefined;
    for (const ref of [`refs/remotes/origin/${repo.baseBranch}`, `refs/heads/${repo.baseBranch}`]) {
      try {
        const { stdout } = await exec("git", ["-C", repo.source, "rev-parse", "--verify", `${ref}^{commit}`], { timeout: 10_000 });
        commit = stdout.trim();
        break;
      } catch { /* try the registered local branch */ }
    }
    if (!commit) throw new Error(`Registered base branch "${repo.baseBranch}" is unavailable for ${name}`);
    const result = await createSessionWorktree({
      repoName: name, srcCheckout: repo.source, baseBranch: repo.baseBranch,
      title: "cloud task", workspaceDir: cloudWorkspaceDir(), baseCommit: commit, copyNodeModules: false,
    });
    if ("error" in result) throw new Error(result.error);
    const gitDir = realpathSync(await cloudGit(result.path, ["rev-parse", "--absolute-git-dir"]));
    const gitIdentity = randomUUID();
    writeFileSync(path.join(gitDir, "flow-task-identity"), gitIdentity, { mode: 0o600 });
    db.prepare("INSERT INTO cloud_worktrees (conversation_key, repo, path, branch, base_commit, git_dir, git_identity) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(key, name, result.path, result.branch, commit, gitDir, gitIdentity);
    applyRepoEnv(name, repo.source, result.path, gitDir);
    return { ...repo, worktree: { ...result, base_commit: commit, git_dir: gitDir, git_identity: gitIdentity } };
  }
}

export async function cloudGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env })).stdout.trimEnd();
}

// Git's per-worktree metadata directory survives branch changes and worktree
// moves. Match that identity, never a branch name or a model-reported path.
export async function reconcileWorktree(key: string, repo: CloudRepo): Promise<void> {
  const tree = repo.worktree!;
  const candidates = (await cloudGit(repo.source, ["worktree", "list", "--porcelain", "-z"]))
    .split("\0").filter((s) => s.startsWith("worktree ")).map((s) => s.slice(9));
  // Normal tool calls should inspect their own tree first, not spawn one Git
  // process for every other retained conversation on this machine.
  let preferred = tree.path;
  if (tree.git_dir && existsSync(path.join(tree.git_dir, "gitdir"))) preferred = path.dirname(readFileSync(path.join(tree.git_dir, "gitdir"), "utf8").trim());
  candidates.sort((a, b) => Number(path.resolve(b) === path.resolve(preferred)) - Number(path.resolve(a) === path.resolve(preferred)));
  let found: string | undefined;
  for (const candidate of candidates) {
    if (!existsSync(path.join(candidate, ".git"))) continue;
    const dir = realpathSync(await cloudGit(candidate, ["rev-parse", "--absolute-git-dir"]));
    if (tree.git_dir ? dir === tree.git_dir : path.resolve(candidate) === path.resolve(tree.path)) {
      const marker = path.join(dir, "flow-task-identity");
      if (tree.git_identity && (!existsSync(marker) || readFileSync(marker, "utf8") !== tree.git_identity)) continue;
      // A legacy row can adopt only a linked worktree, never the source root.
      if (realpathSync(candidate) === realpathSync(repo.source)) throw new Error("Task points at the shared source checkout");
      found = realpathSync(candidate);
      tree.git_dir = dir;
      if (!tree.git_identity) {
        tree.git_identity = randomUUID();
        writeFileSync(marker, tree.git_identity, { mode: 0o600 });
      }
      break;
    }
  }
  if (!found) throw new Error("Conversation worktree is missing or replaced; its saved identity could not be found");
  const branch = await cloudGit(found, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  tree.path = found;
  tree.branch = branch; // empty = detached; checkpointing still preserves HEAD.
  tree.archived_at = null;
  db.prepare("UPDATE cloud_worktrees SET path = ?, branch = ?, git_dir = ?, git_identity = ?, archived_at = NULL WHERE conversation_key = ? AND repo = ?")
    .run(found, branch, tree.git_dir, tree.git_identity, key, repo.name);
}

const turns = new Map<string, Promise<unknown>>();
export function withConversationTurn<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = turns.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  turns.set(key, next);
  void next.finally(() => { if (turns.get(key) === next) turns.delete(key); }).catch(() => {});
  return next;
}

export async function restoreConversationWorktrees(key: string, refreshEnv = false): Promise<void> {
  if (db.prepare("SELECT 1 FROM cloud_worktrees WHERE conversation_key = ?").get(key)) {
    for (const repo of conversationRepos(key)) if (repo.worktree) await ensureConversationWorktree(key, repo.name, refreshEnv);
  }
  db.prepare("UPDATE cloud_conversations SET updated_at = unixepoch() WHERE conversation_key = ?").run(key);
}

export async function reconcileConversation(key: string): Promise<void> {
  db.prepare("UPDATE cloud_conversations SET updated_at = unixepoch() WHERE conversation_key = ?").run(key);
  if (!db.prepare("SELECT 1 FROM cloud_worktrees WHERE conversation_key = ?").get(key)) return;
  for (const repo of conversationRepos(key)) if (repo.worktree && !repo.worktree.archived_at) {
    try { await reconcileWorktree(key, repo); }
    catch {
      db.prepare("UPDATE cloud_worktrees SET cleanup_error = ? WHERE conversation_key = ? AND repo = ?")
        .run("Worktree identity could not be reconciled; manual inspection required", key, repo.name);
    }
  }
}

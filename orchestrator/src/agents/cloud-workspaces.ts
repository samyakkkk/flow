import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import db from "../db.js";
import { createSessionWorktree } from "./worktrees.js";

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
  worktree?: { path: string; branch: string; base_commit: string };
}

export function cloudMode(): boolean {
  return process.env.FLOW_MODE === "prod";
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
      "SELECT path, branch, base_commit FROM cloud_worktrees WHERE conversation_key = ? AND repo = ?",
    ).get(key, repo.name) as CloudRepo["worktree"];
    return { name: repo.name, source: path.join(workspace, "repos", repo.name), baseBranch: repo.branch, worktree };
  });
}

// One orchestrator owns a project DB. Serialize creation so parallel tool calls
// cannot allocate two branches for the same conversation/repo.
const creating = new Map<string, Promise<CloudRepo>>();

export async function ensureConversationWorktree(key: string, name: string): Promise<CloudRepo> {
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
      // Never silently replace a missing tree or lose a conversation's edits.
      const root = realpathSync(repo.worktree.path);
      const { stdout } = await exec("git", ["-C", root, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
      if (realpathSync(stdout.trim()) !== root) throw new Error("Conversation worktree is no longer valid");
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
    db.prepare("INSERT INTO cloud_worktrees (conversation_key, repo, path, branch, base_commit) VALUES (?, ?, ?, ?, ?)")
      .run(key, name, result.path, result.branch, commit);
    return { ...repo, worktree: { ...result, base_commit: commit } };
  }
}

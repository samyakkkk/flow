import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import db from "../db.js";
import { containsSecret } from "../events.js";
import { cloudGit, cloudMode, conversationRepos, reconcileWorktree, withConversationTurn, type CloudRepo } from "./cloud-workspaces.js";
import { requestCodingSlot, releaseCodingSlot } from "./coding-slot.js";

const split = (s: string) => s.split("\0").filter(Boolean);
const disposable = new Set(["node_modules", ".next", ".nuxt", ".turbo", "__pycache__", ".pytest_cache"]);
const sensitiveName = (name: string) => /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|credentials(?:\.[^/]*)?|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i.test(name);

async function checkpoint(key: string, repo: CloudRepo): Promise<void> {
  await reconcileWorktree(key, repo);
  const tree = repo.worktree!;
  const cwd = tree.path;
  const metadata = tree.git_dir!;
  const unchangedEnv = (name: string) => {
    if (!/^\.env(?:\.[^/]+)?$/.test(name)) return false;
    const local = path.join(cwd, name), source = path.join(repo.source, name);
    return existsSync(local) && existsSync(source) && lstatSync(local).isFile() && lstatSync(source).isFile() && readFileSync(local).equals(readFileSync(source));
  };
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START", "index.lock"]) {
    if (existsSync(path.join(metadata, marker))) throw new Error("Git operation is in progress; retained workspace");
  }
  if ((await cloudGit(cwd, ["ls-files", "--unmerged"])).length) throw new Error("Unresolved conflicts; retained workspace");
  if ((await cloudGit(cwd, ["ls-files", "--stage"])).split("\n").some((s) => s.startsWith("160000 "))) {
    throw new Error("Submodule workspace requires manual cleanup");
  }

  // Only discard known rebuildable caches and unchanged copies of source env
  // files. Unknown ignored state (local databases, uploads, etc.) keeps the tree.
  const ignored = split(await cloudGit(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]));
  for (const name of ignored) {
    if (name.split("/").some((part) => disposable.has(part))) continue;
    if (unchangedEnv(name)) continue;
    throw new Error("Unrecognized ignored files; retained workspace");
  }
  const changed = new Set([
    ...split(await cloudGit(cwd, ["diff", "--no-renames", "HEAD", "--name-only", "-z"])),
    ...split(await cloudGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);
  const fingerprint = () => [...changed].map((name) => {
    const target = path.join(cwd, name);
    return existsSync(target) ? createHash("sha256").update(readFileSync(target)).digest("hex") : "deleted";
  }).join(":");
  for (const name of changed) {
    if (unchangedEnv(name) && !(await cloudGit(cwd, ["ls-files", "--", name]))) continue;
    if (sensitiveName(name)) throw new Error("Credential-related changes require manual preservation; retained workspace");
    const target = path.join(cwd, name);
    if (!existsSync(target)) continue; // deletion is part of the checkpoint
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) throw new Error("Large or special changed file; retained workspace");
    // Ensure a path through a symlink cannot read outside the owned tree.
    const relative = path.relative(realpathSync(cwd), realpathSync(target));
    if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Changed path escapes workspace");
    if (containsSecret(readFileSync(target, "utf8"))) throw new Error("Possible credential in changed file; retained workspace");
  }

  const head = await cloudGit(cwd, ["rev-parse", "HEAD"]);
  const status = await cloudGit(cwd, ["status", "--porcelain=v1", "-z"]);
  if (split(status).some((s) => s[0] !== " " && s[1] !== " " && !s.startsWith("??"))) {
    throw new Error("Partially staged changes; retained workspace");
  }
  const contents = fingerprint();
  const index = path.join(metadata, `flow-checkpoint-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "Flow", GIT_AUTHOR_EMAIL: "flow@localhost", GIT_COMMITTER_NAME: "Flow", GIT_COMMITTER_EMAIL: "flow@localhost" };
  let commit = head;
  try {
    await cloudGit(cwd, ["read-tree", "HEAD"], env);
    const files = [...changed].filter((name) => !/^\.env(?:\.[^/]+)?$/.test(name));
    for (let offset = 0; offset < files.length; offset += 100) {
      await cloudGit(cwd, ["--literal-pathspecs", "add", "--all", "--", ...files.slice(offset, offset + 100)], env);
    }
    const snapshot = await cloudGit(cwd, ["write-tree"], env);
    if (snapshot !== await cloudGit(cwd, ["rev-parse", "HEAD^{tree}"])) {
      commit = await cloudGit(cwd, ["commit-tree", snapshot, "-p", head, "-m", "Flow: checkpoint inactive task"], env);
    }
  } finally {
    if (existsSync(index)) unlinkSync(index);
  }
  if (contents !== fingerprint() || head !== await cloudGit(cwd, ["rev-parse", "HEAD"]) || status !== await cloudGit(cwd, ["status", "--porcelain=v1", "-z"])) {
    throw new Error("Workspace changed during checkpoint; retained workspace");
  }
  const suffix = createHash("sha256").update(key).digest("hex").slice(0, 20);
  const branch = `flow/checkpoints/${suffix}/${repo.name}`;
  const ref = `refs/heads/${branch}`;
  const previous = await cloudGit(repo.source, ["rev-parse", "--verify", ref]).catch(() => "0".repeat(40));
  // Never move a checkpoint branch currently checked out in another tree.
  const entries = (await cloudGit(repo.source, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
  if (entries.some((e) => e.split("\0").includes(`branch ${ref}`) && !e.split("\0").includes(`worktree ${cwd}`))) {
    throw new Error("Checkpoint branch is in use elsewhere; retained workspace");
  }
  await cloudGit(repo.source, ["update-ref", ref, commit, previous]);
  // Persist BEFORE removal: a crash afterwards can restore the exact commit.
  db.prepare("UPDATE cloud_worktrees SET branch = ?, checkpoint_commit = ?, archived_at = unixepoch(), cleanup_error = NULL WHERE conversation_key = ? AND repo = ?")
    .run(branch, commit, key, repo.name);
  await cloudGit(repo.source, ["worktree", "remove", "--force", cwd]);
}

export async function cleanupConversation(key: string): Promise<{ archived: number; retained: number }> {
  return withConversationTurn(key, async () => {
    const result = { archived: 0, retained: 0 };
    if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued', 'running') AND json_extract(input, '$.conversation_key') = ?").get(key)) return result;
    const lease = `cleanup:${randomUUID()}`;
    try {
      if (!requestCodingSlot(lease).acquired) return result;
      for (const repo of conversationRepos(key)) {
        if (!repo.worktree || (repo.worktree.archived_at && !existsSync(repo.worktree.path))) continue;
        try { await checkpoint(key, repo); result.archived++; }
        catch (error) {
          result.retained++;
          // Store only our diagnostic, not Git's command/stderr (may contain secrets).
          const message = error instanceof Error && !('cmd' in error) ? error.message : "Git checkpoint failed; retained workspace";
          db.prepare("UPDATE cloud_worktrees SET cleanup_error = ? WHERE conversation_key = ? AND repo = ?").run(message, key, repo.name);
        }
      }
      return result;
    } finally { releaseCodingSlot(lease); }
  });
}

let sweeping = false;
export async function sweepCloudWorkspaces(): Promise<void> {
  const hours = Number(process.env.FLOW_WORKTREE_IDLE_HOURS ?? 72);
  if (!cloudMode() || sweeping || !Number.isFinite(hours) || hours <= 0) return;
  sweeping = true;
  try {
    const rows = db.prepare(`SELECT conversation_key FROM cloud_conversations WHERE updated_at < ?`).all(Math.floor(Date.now() / 1000 - hours * 3600)) as { conversation_key: string }[];
    for (const { conversation_key: key } of rows) {
      // Recheck after preceding cleanup jobs; a new turn can have touched it.
      const recent = db.prepare("SELECT 1 FROM cloud_conversations WHERE conversation_key = ? AND updated_at >= ?").get(key, Math.floor(Date.now() / 1000 - hours * 3600));
      if (!recent) await cleanupConversation(key);
    }
  } finally { sweeping = false; }
}

export function startWorkspaceCleanup(): () => void {
  const timer = setInterval(() => { void sweepCloudWorkspaces().catch((e) => console.warn("[cloud-cleanup] sweep failed:", e.message)); }, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

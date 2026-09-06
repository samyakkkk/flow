import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { parse } from "shell-quote";
import type { CloudRepo } from "./cloud-workspaces.js";

export const CLOUD_AGENT_PROMPT = `You are Flow's cloud coding agent, powered only by OpenCode.
Use the knowledge graph to orient and discover relevant repositories. Verify answers against code and cite file:line evidence.
Use flow_workspace without arguments to discover repositories and this conversation's existing worktrees.
Questions need no worktree: use read, grep and glob against the returned source directories. Do not run shell commands to answer simple source questions.
Only when the user requests changes, call flow_workspace with repo and edit=true. Re-read files in the returned worktree before editing them.
The same conversation can acquire more worktrees as you discover other repositories to change. Reuse existing worktrees on follow-ups.
All edits and commands must target your conversation's worktrees. Shared clones are read-only evidence. Never change their branches or files.
Set bash.workdir explicitly to the chosen worktree. Do not use cd or Git directory overrides; Flow has already created your branch.
Use the bash tool result and its exit metadata as execution evidence. A new shell cannot retrieve the previous shell exit status; do not run echo $? to check it. Once the requested check succeeds, report the result without rerunning it unless a new change or failure requires another check.
Tests and dependency installation also write files, so run them in the worktree. Existing host CLI authentication is available.
Flow serializes coding across this machine. Your first edit or shell command may wait for another task; ordinary questions can run concurrently.
Keep processes in the foreground. Do not use nohup, setsid, daemon mode, Docker, system services, global installs, or change shared CLI configuration. Install tools locally in your worktree. Flow stops task processes at the end of each turn.
Flow may checkpoint an inactive worktree locally and remove it to save disk. On a follow-up it restores your files; rediscover paths with flow_workspace. Branch names and paths can change; the Slack conversation is the task identity.
Never read credentials or .env files. Never copy secrets into responses or commits. Do not claim that unmerged changes describe the base branch.
Graph tools are read-only except remember and correct_graph (advisory flags). Do not mutate graph entities directly.
Return JSON: {"answer_md":"<answer or change summary, validation, and branch/PR when applicable>","citations":[{"kind":"file|node|slack|linear","ref":"<reference>"}],"confidence":0.9,"gaps":[]}.
Do not claim tests passed or a PR was created unless the corresponding tool actually succeeded.`;

export const CLOUD_PERMISSIONS = {
  "*": "deny", read: "allow", glob: "allow", grep: "allow", edit: "allow", bash: "allow",
  flow_workspace: "allow", todowrite: "allow", todoread: "allow", external_directory: "allow",
  "graph_*": "allow",
} as const;

export function cloudOpencodeConfig(inherited: Record<string, unknown> = {}) {
  // Explicit tool keys also override permissive entries in machine config;
  // OpenCode deep-merges configuration, so a wildcard alone is insufficient.
  const denied = Object.fromEntries([
    ...Object.keys(CLOUD_PERMISSIONS), "task", "batch", "skill", "webfetch", "websearch", "lsp",
  ].map((name) => [name, "deny"]));
  return {
    ...inherited,
    plugin: [new URL("./cloud-opencode-plugin.ts", import.meta.url).href],
    default_agent: "flow-cloud", snapshot: false, lsp: false, formatter: false,
    // Only a successfully loaded plugin enables tools in its config hook.
    permission: denied,
    agent: { "flow-cloud": { mode: "primary", prompt: CLOUD_AGENT_PROMPT, permission: denied } },
  };
}

// Unknown paths can have non-existent final components (a new file). Resolve
// the closest existing ancestor so symlink escapes are still rejected.
export function canonicalPath(target: string): string {
  const suffix: string[] = [];
  let current = path.resolve(target);
  while (!existsSync(current)) {
    // A dangling symlink must fail rather than being treated as a new file.
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Dangling symlink is not a writable path"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot resolve path: ${target}`);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...suffix);
}

function within(root: string, target: string): boolean {
  const rel = path.relative(canonicalPath(root), canonicalPath(target));
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

function assertCodePath(target: string): void {
  for (const part of canonicalPath(target).split(path.sep)) {
    if (part === ".git" || part === ".env" || part.startsWith(".env.")) {
      throw new Error("Git metadata and credential files are not exposed to cloud tools");
    }
  }
  // Also catch a .git alias whose canonical destination happens to be inside a tree.
  if (path.resolve(target).split(path.sep).includes(".git")) throw new Error("Git metadata is managed by Flow");
}

function assertWorktree(root: string): void {
  try {
    if (lstatSync(path.join(root, ".git")).isFile()) return;
  } catch { /* fail closed if a retained workspace was removed */ }
  throw new Error("Conversation worktree is missing or is no longer a linked Git worktree");
}

// OpenCode's apply_patch format has explicit file/move headers. Only headers
// carry paths; '+'/'-' hunk contents cannot create a second target.
export function patchPaths(patch: string): string[] {
  const lines = patch.trim().split(/\r?\n/);
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("Expected an OpenCode patch with explicit file headers");
  }
  const paths: string[] = [];
  for (const line of lines.slice(1, -1)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match) paths.push(match[1].trim());
    else if (line.startsWith("*** ") && line !== "*** End of File") {
      throw new Error("Unsupported patch header; use edit or write");
    }
  }
  if (!paths.length) throw new Error("Patch has no file targets");
  return paths;
}

const GRAPH_TOOLS = new Set([
  "orient", "find_entity", "get_entity", "read_query", "list_schema", "search_knowledge",
  "source_read", "source_search",
  "remember", "correct_graph", "notify",
].map((name) => `graph_${name}`));

function checkShellCommand(command: string, repos: CloudRepo[]): void {
  const refused = () => { throw new Error("Run commands in workdir without changing directories, branches, Git metadata, or targeting shared clones"); };
  // Tokenize quoted/escaped arguments before checking explicit paths and Git
  // options. This is intentionally not an evaluator for scripts or programs.
  const tokens = parse(command, () => refused());
  const words = tokens.flatMap((token) => typeof token === "string" ? [token] :
    "pattern" in token ? [token.pattern] : []);
  if (command.includes("`") || command.includes("$(")) refused();
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (["nohup", "setsid", "disown", "docker", "podman", "systemctl", "service", "sudo"].includes(path.basename(word)) ||
        ["--global", "--daemon", "--detach"].includes(word) || word === "-g") refused();
    if (["cd", "chdir", "pushd", "popd"].includes(word) || /\.\.[/\\]|^GIT_[A-Z_]+=|^--(?:git-dir|work-tree)|(?:^|[/\\])\.git(?:[/\\]|$)/.test(word)) refused();
    if (repos.some((r) => word.includes(r.source) || word.includes(canonicalPath(r.source)) ||
      word.includes(path.dirname(r.source) + path.sep))) refused();
    if (path.basename(word) === "git") {
      const tail = words.slice(i + 1);
      if (tail.some((arg) => arg.startsWith("-C") || arg.startsWith("-c") || arg.startsWith("--git-dir") || arg.startsWith("--work-tree"))) refused();
      const subcommand = tail.find((arg) => !arg.startsWith("-"));
      if (subcommand && ["checkout", "switch", "worktree", "update-ref", "symbolic-ref", "config", "branch"].includes(subcommand)) refused();
    }
  }
}

export function createCloudToolPolicy(options: {
  directory: string;
  repos: () => Promise<CloudRepo[]>;
  ensure: (repo: string) => Promise<CloudRepo>;
  acquire?: () => Promise<void>;
}) {
  const absolute = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("An explicit repository path is required");
    return path.resolve(options.directory, value);
  };

  return async (tool: string, args: Record<string, unknown>): Promise<void> => {
    if (GRAPH_TOOLS.has(tool) || tool === "flow_workspace" || tool === "todowrite" || tool === "todoread") return;
    if (!["read", "glob", "grep", "write", "edit", "apply_patch", "bash"].includes(tool)) {
      throw new Error(`Tool "${tool}" is not enabled for cloud tasks`);
    }
    if (["write", "edit", "apply_patch", "bash"].includes(tool)) await options.acquire?.();
    const repos = await options.repos();
    for (const repo of repos) if (repo.worktree) assertWorktree(repo.worktree.path);

    if (tool === "read" || tool === "glob" || tool === "grep") {
      const field = tool === "read" ? "filePath" : "path";
      const target = absolute(args[field]);
      assertCodePath(target);
      for (const repo of repos) {
        if (within(repo.source, target)) {
          args[field] = repo.worktree
            ? path.join(repo.worktree.path, path.relative(canonicalPath(repo.source), canonicalPath(target)))
            : target;
          assertCodePath(String(args[field]));
          if (repo.worktree && !within(repo.worktree.path, String(args[field]))) throw new Error("Read escapes the worktree");
          return;
        }
        if (repo.worktree && within(repo.worktree.path, target)) return;
      }
      throw new Error("Read from a registered repo or this conversation's worktree; use flow_workspace to list paths");
    }

    if (tool === "bash") {
      if (typeof args.command !== "string") throw new Error("command is required");
      let command = args.command;
      let workdir = args.workdir;
      // Models often send `cd <tree> && command` even with a workdir field.
      // Translate only this simple prefix into an owned cwd; never execute cd.
      const prefix = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&\s*([\s\S]+)$/.exec(command);
      if (prefix) {
        const target = absolute(prefix[1] ?? prefix[2] ?? prefix[3]);
        if (!repos.some((r) => r.worktree && within(r.worktree.path, target)) ||
            (workdir !== undefined && canonicalPath(absolute(workdir)) !== canonicalPath(target))) {
          throw new Error("Run commands in workdir without changing directories, branches, Git metadata, or targeting shared clones");
        }
        workdir = target;
        command = prefix[4];
      }
      const owned = repos.filter((r) => r.worktree);
      if (workdir === undefined && owned.length === 1) workdir = owned[0].worktree!.path;
      const cwd = absolute(workdir);
      const repo = repos.find((r) => r.worktree && within(r.worktree.path, cwd));
      if (!repo) throw new Error("Shell commands require an existing conversation worktree in workdir; use flow_workspace(repo, edit=true)");
      // These catch direct attempts to leave the selected tree or mutate shared
      // Git administration. They do not inspect programs launched by a command:
      // worktree mode is an execution policy, not an OS sandbox.
      checkShellCommand(command, repos);
      args.command = command;
      args.workdir = canonicalPath(cwd);
      return;
    }

    const targets = tool === "apply_patch"
      ? patchPaths(String(args.patchText ?? "")).map(absolute)
      : [absolute(args.filePath)];
    const redirects: string[] = [];
    for (const target of targets) {
      assertCodePath(target);
      const own = repos.find((r) => r.worktree && within(r.worktree.path, target));
      if (own) continue;
      const source = repos.find((r) => within(r.source, target));
      if (!source) throw new Error("Edits must stay inside this conversation's worktrees");
      const prepared = await options.ensure(source.name);
      if (!prepared.worktree) throw new Error("Worktree creation returned no path; edit refused");
      redirects.push(path.join(prepared.worktree.path, path.relative(canonicalPath(source.source), canonicalPath(target))));
    }
    if (redirects.length) {
      // Do not silently rewrite a patch's base or OpenCode's read-before-write
      // bookkeeping. No part of the original edit executes.
      throw new Error(`Shared checkout edit blocked. Worktree ready. Re-read and retry using these paths:\n${redirects.join("\n")}`);
    }
  };
}

/** Tool evidence wins over a model's claim that a blocked test passed. */
export function cloudShellVerificationFailed(transcript: string): boolean {
  let attempted = false, succeeded = false;
  for (const line of transcript.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "tool_use" || event.part?.tool !== "bash") continue;
      attempted = true;
      if (event.part.state?.status === "completed" && event.part.state?.metadata?.exit === 0) succeeded = true;
    } catch { /* malformed events do not establish success */ }
  }
  return attempted && !succeeded;
}

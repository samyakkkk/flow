import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createCloudToolPolicy, patchPaths, cloudShellVerificationFailed } from "../src/agents/cloud-tool-policy.js";

const root = mkdtempSync(path.join(tmpdir(), "flow-cloud-test-"));
process.env.DB_PATH = ":memory:";
process.env.FLOW_MODE = "prod";
process.env.FLOW_ADMIN_TOKEN = "cloud-test-admin";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";
process.env.GATEWAY_URL = "http://127.0.0.1:1";
process.env.FLOW_EMBED_URL = "http://127.0.0.1:1";
process.env.OPENCODE_WORKSPACE_DIR = root;
process.env.FLOW_CODING_STATE_DIR = path.join(root, "coding-state");
process.env.REPOS_JSON_PATH = path.join(root, "repos.json");

let workspaces: typeof import("../src/agents/cloud-workspaces.js");
let jobs: typeof import("../src/opencode.js");
let db: typeof import("../src/db.js").default;
const app = Fastify();
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const source = (name: string) => path.join(root, "repos", name);
let sequence = 0;

function context() {
  const key = workspaces.conversationKey({ source: "test", id: String(++sequence) });
  workspaces.ensureConversation(key);
  const policy = createCloudToolPolicy({
    directory: root,
    repos: async () => workspaces.conversationRepos(key),
    ensure: (repo) => workspaces.ensureConversationWorktree(key, repo),
  });
  return { key, policy };
}

async function finished(id: string) {
  for (let i = 0; i < 100; i++) {
    const job = jobs.getJob(id)!;
    if (job.status === "done" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${id} did not finish`);
}

before(async () => {
  for (const name of ["api", "web"]) {
    mkdirSync(source(name), { recursive: true });
    git(source(name), "init", "-q", "-b", "main");
    git(source(name), "config", "user.email", "test@example.com");
    git(source(name), "config", "user.name", "Test");
    writeFileSync(path.join(source(name), "file.txt"), "base\n");
    git(source(name), "add", ".");
    git(source(name), "commit", "-qm", "base");
  }
  writeFileSync(process.env.REPOS_JSON_PATH!, JSON.stringify({ repos: [
    { name: "api", branch: "main" }, { name: "web", branch: "main" },
  ] }));
  workspaces = await import("../src/agents/cloud-workspaces.js");
  jobs = await import("../src/opencode.js");
  db = (await import("../src/db.js")).default;
  const { requireAuth } = await import("../src/auth.js");
  const { registerCloudTaskRoutes } = await import("../src/agents/cloud-routes.js");
  app.addHook("onRequest", requireAuth);
  registerCloudTaskRoutes(app);
  (await import("../src/agents/repo-env-routes.js")).registerRepoEnvRoutes(app);
  (await import("../src/agents/cloud-view-routes.js")).registerCloudViewRoutes(app);
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

test("questions read registered repos without creating a worktree", async () => {
  const { key, policy } = context();
  await policy("read", { filePath: path.join(source("api"), "file.txt") });
  await policy("grep", { path: source("web"), pattern: "base" });
  assert.equal(workspaces.conversationRepos(key).filter((r) => r.worktree).length, 0);
  assert.equal(git(source("api"), "worktree", "list", "--porcelain").split("worktree ").length, 2);
});

test("first edit is blocked, allocates a worktree, and can be retried there", async () => {
  const { key, policy } = context();
  const original = path.join(source("api"), "file.txt");
  const head = git(source("api"), "rev-parse", "HEAD");
  await assert.rejects(policy("edit", { filePath: original }), /Shared checkout edit blocked/);
  const repo = workspaces.conversationRepos(key).find((r) => r.name === "api")!;
  const filePath = path.join(repo.worktree!.path, "file.txt");
  const read = { filePath: original };
  await policy("read", read);
  assert.equal(realpathSync(read.filePath), realpathSync(filePath), "reads follow the conversation's edits");
  await policy("edit", { filePath });
  writeFileSync(filePath, "edited\n");
  assert.equal(readFileSync(original, "utf8"), "base\n");
  assert.equal(git(source("api"), "branch", "--show-current"), "main");
  assert.equal(git(source("api"), "rev-parse", "HEAD"), head);
  assert.equal(git(source("api"), "status", "--porcelain"), "");
});

test("parallel requests reuse a tree; more repos and other conversations get distinct trees", async () => {
  const { key } = context();
  const [a, b] = await Promise.all([
    workspaces.ensureConversationWorktree(key, "api"), workspaces.ensureConversationWorktree(key, "api"),
  ]);
  assert.equal(a.worktree!.path, b.worktree!.path);
  const web = await workspaces.ensureConversationWorktree(key, "web");
  const other = await workspaces.ensureConversationWorktree(context().key, "api");
  assert.notEqual(web.worktree!.path, a.worktree!.path);
  assert.notEqual(other.worktree!.path, a.worktree!.path);
  assert.equal(workspaces.conversationRepos(key).filter((r) => r.worktree).length, 2);
});

test("a new policy instance reuses durable edits, while new trees use the registered base", async () => {
  const { key } = context();
  const first = await workspaces.ensureConversationWorktree(key, "api");
  const target = path.join(first.worktree!.path, "file.txt");
  writeFileSync(target, "retained edit\n");
  const policy = createCloudToolPolicy({
    directory: root, repos: async () => workspaces.conversationRepos(key),
    ensure: (repo) => workspaces.ensureConversationWorktree(key, repo),
  });
  const args = { filePath: path.join(source("api"), "file.txt") };
  await policy("read", args);
  assert.equal(readFileSync(args.filePath, "utf8"), "retained edit\n");
  const fresh = await workspaces.ensureConversationWorktree(context().key, "api");
  assert.equal(fresh.worktree!.base_commit, git(source("api"), "rev-parse", "main"));
  assert.equal(readFileSync(path.join(fresh.worktree!.path, "file.txt"), "utf8"), "base\n");
});

test("an unavailable registered branch never falls back to another HEAD", async () => {
  const registryFile = process.env.REPOS_JSON_PATH!;
  const original = readFileSync(registryFile, "utf8");
  const registry = JSON.parse(original);
  registry.repos[0].branch = "missing-branch";
  writeFileSync(registryFile, JSON.stringify(registry));
  try {
    const { key } = context();
    await assert.rejects(workspaces.ensureConversationWorktree(key, "api"), /base branch.*unavailable/);
    assert.equal(workspaces.conversationRepos(key)[0].worktree, undefined);
  } finally {
    writeFileSync(registryFile, original);
  }
});

test("missing worktrees fail instead of replacing edits or falling back to the source", async () => {
  const { key, policy } = context();
  const repo = await workspaces.ensureConversationWorktree(key, "api");
  git(source("api"), "worktree", "remove", repo.worktree!.path);
  await assert.rejects(workspaces.ensureConversationWorktree(key, "api"), /missing or replaced/);
  await assert.rejects(policy("write", { filePath: path.join(repo.worktree!.path, "new.txt") }), /worktree is missing/);
  assert.equal(workspaces.conversationRepos(key)[0].worktree!.path, repo.worktree!.path);
});

test("unregistered repos, traversal, other conversations, symlinks and Git metadata are refused", async () => {
  const { key, policy } = context();
  await assert.rejects(workspaces.ensureConversationWorktree(key, "../api"), /Unknown code repo/);
  await assert.rejects(policy("write", { filePath: path.join(root, "outside.txt") }), /Edits must stay/);
  const own = await workspaces.ensureConversationWorktree(key, "api");
  const other = await workspaces.ensureConversationWorktree(context().key, "api");
  await assert.rejects(policy("edit", { filePath: path.join(other.worktree!.path, "file.txt") }), /Edits must stay/);
  symlinkSync(root, path.join(own.worktree!.path, "escape"));
  await assert.rejects(policy("write", { filePath: path.join(own.worktree!.path, "escape", "outside.txt") }), /Edits must stay/);
  await assert.rejects(policy("write", { filePath: path.join(own.worktree!.path, ".git") }), /Git metadata/);
  await assert.rejects(policy("read", { filePath: path.join(source("api"), ".git", "HEAD") }), /Git metadata/);
  await assert.rejects(policy("write", { filePath: path.join(own.worktree!.path, ".env") }), /credential files/);
  symlinkSync(path.join(root, "missing"), path.join(own.worktree!.path, "dangling"));
  await assert.rejects(policy("write", { filePath: path.join(own.worktree!.path, "dangling", "new.txt") }), /Dangling symlink/);
  assert.equal(existsSync(path.join(root, "outside.txt")), false);
});

test("patch checks include deletions and move destinations before any edit executes", async () => {
  const { key, policy } = context();
  const own = await workspaces.ensureConversationWorktree(key, "api");
  const target = path.join(own.worktree!.path, "file.txt");
  const patchText = `*** Begin Patch\n*** Update File: ${target}\n*** Move to: ${root}/outside.txt\n@@\n-base\n+changed\n*** End Patch`;
  assert.deepEqual(patchPaths(patchText), [target, `${root}/outside.txt`]);
  await assert.rejects(policy("apply_patch", { patchText }), /Edits must stay/);
  await assert.rejects(policy("apply_patch", { patchText: `*** Begin Patch\n*** Delete File: ${source("web")}/file.txt\n*** End Patch` }), /Shared checkout edit blocked/);
  assert.equal(readFileSync(target, "utf8"), "base\n");
});

test("shell selects an unambiguous owned worktree and refuses source/branch operations", async () => {
  const { key, policy } = context();
  await assert.rejects(policy("bash", { command: "git checkout other", workdir: source("api") }), /existing conversation worktree/);
  assert.equal(workspaces.conversationRepos(key).filter((r) => r.worktree).length, 0);
  const repo = await workspaces.ensureConversationWorktree(key, "api");
  const workdir = repo.worktree!.path;
  const inferred: Record<string, unknown> = { command: "npm test" };
  await policy("bash", inferred);
  assert.equal(inferred.workdir, realpathSync(workdir));
  const prefixed: Record<string, unknown> = { command: `cd '${workdir}' && node --version` };
  await policy("bash", prefixed);
  assert.equal(prefixed.command, "node --version");
  assert.equal(prefixed.workdir, realpathSync(workdir));
  for (const command of [
    `git -C ${source("api")} checkout other`, "git switch main", "git worktree remove ../other",
    `cd ${source("api")} && npm test`, `echo x > ${source("api")}/file.txt`,
    "git --git-dir=../repo/.git reset --hard", "GIT_WORK_TREE=../repo git reset --hard",
    "'git' 'switch' main", "g\\it check\\out main",
  ]) await assert.rejects(policy("bash", { command, workdir }), /without changing/);
  await policy("bash", { command: "npm test", workdir });
  await policy("bash", { command: "git diff --stat", workdir });
  await policy("bash", { command: "git add . && git commit -m 'Fix behavior'", workdir });
  await workspaces.ensureConversationWorktree(key, "web");
  await assert.rejects(policy("bash", { command: "npm test" }), /explicit repository path/);
});

test("blocked shell attempts cannot establish a passing verification", () => {
  const event = (status: string, exit?: number) => JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { status, metadata: { exit } } } });
  assert.equal(cloudShellVerificationFailed(event("error")), true);
  assert.equal(cloudShellVerificationFailed(event("completed", 1)), true);
  assert.equal(cloudShellVerificationFailed(event("error") + "\n" + event("completed", 0)), false);
  assert.equal(cloudShellVerificationFailed("ordinary read-only answer"), false);
});

test("unknown tools, delegated agents and graph mutations fail closed", async () => {
  const { policy } = context();
  for (const name of ["task", "batch", "shell", "graph_upsert_entity", "new_editor"]) {
    await assert.rejects(policy(name, {}), /not enabled/);
  }
  await policy("graph_search_knowledge", {});
  await policy("graph_source_read", { repo: "api", path: "file.txt" });
  await policy("graph_source_search", { repo: "api", query: "base" });
  await policy("graph_correct_graph", {});
});

test("task endpoint is prod-only, authenticated and OpenCode-only", async () => {
  const payload = { message: "Explain retries", conversation: { source: "teams", workspace: "tenant", id: "thread" } };
  const post = (body = payload, token = "cloud-test-admin") => app.inject({ method: "POST", url: "/v1/agents/tasks", payload: body, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await post(payload, "bad")).statusCode, 401);
  assert.equal((await post({ ...payload, backend: "codex" } as typeof payload)).statusCode, 400);
  assert.equal((await post({ ...payload, conversation: {} } as typeof payload)).statusCode, 400);
  process.env.FLOW_MODE = "local";
  assert.equal((await post()).statusCode, 409);
  process.env.FLOW_MODE = "prod";
  const reply = await post();
  assert.equal(reply.statusCode, 202);
  const job = await finished(reply.json().id);
  assert.equal(job.status, "done");
  const key = workspaces.conversationKey(payload.conversation);
  assert.ok(workspaces.conversationSession(key));
  assert.equal(workspaces.conversationRepos(key).filter((r) => r.worktree).length, 0);
});

test("rapid turns serialize and resume the same session, including before the initial reply", async () => {
  const conversation = { source: "webhook", id: "rapid" };
  const [a, b] = await Promise.all([
    jobs.enqueueJob({ type: "answer", input: { question: "Explain", conversation, simulate_delay_ms: 50 } }),
    jobs.enqueueJob({ type: "answer", input: { question: "Now edit", conversation } }),
  ]);
  const first = await finished(a.id);
  const second = await finished(b.id);
  assert.equal(first.status, "done");
  assert.equal(second.status, "done");
  assert.equal(second.session_id, first.session_id);
  assert.match(JSON.parse(second.result_json!).answer_md, /Continued/);
  assert.equal(workspaces.conversationSession(workspaces.conversationKey(conversation)), first.session_id);
});

test("cancelled queued turns never start and running turns cannot overwrite cancellation", async () => {
  const conversation = { source: "test", id: "cancellation" };
  const first = await jobs.enqueueJob({ type: "answer", input: { question: "First", conversation, simulate_delay_ms: 100 } });
  const queued = await jobs.enqueueJob({ type: "answer", input: { question: "Queued", conversation } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.getJob(first.id)!.status, "running");
  assert.equal(jobs.getJob(queued.id)!.status, "queued");
  assert.equal(jobs.cancelCloudJob(queued.id), true);
  assert.equal(jobs.cancelCloudJob(first.id), true);
  assert.equal(jobs.cancelCloudJob(first.id), false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const { id } of [first, queued]) {
    const job = jobs.getJob(id)!;
    assert.equal(job.status, "failed");
    assert.equal(JSON.parse(job.result_json!).error, "cancelled");
    assert.equal(job.session_id, null);
  }
  assert.equal(workspaces.conversationSession(workspaces.conversationKey(conversation)), undefined);
  const next = await jobs.enqueueJob({ type: "answer", input: { question: "Retry", conversation } });
  assert.equal((await finished(next.id)).status, "done");
});

test("active Slack runtime retains its session and worktree across messages", async () => {
  const { FlowRuntime } = await import("../src/slack-agent/runtime.js");
  const runtime = new FlowRuntime();
  const context = { surface: "channel" as const, teamId: "T-active", channelId: "C-active", threadTs: "123.0", userId: "U1" };
  const key = workspaces.conversationKey(workspaces.slackConversation(context.teamId, context.channelId, context.threadTs));
  await runtime.ask({ prompt: "Explain retries", transcript: [], context });
  const session = workspaces.conversationSession(key);
  assert.ok(session);
  assert.equal(workspaces.conversationRepos(key).filter((r) => r.worktree).length, 0);
  const repo = await workspaces.ensureConversationWorktree(key, "api");
  writeFileSync(path.join(repo.worktree!.path, "file.txt"), "retained Slack edit\n");
  const followup = await runtime.ask({ prompt: "Now update tests", transcript: [], context });
  assert.match(followup.markdown, /Continued/);
  assert.equal(workspaces.conversationSession(key), session);
  assert.equal(readFileSync(path.join(workspaces.conversationRepos(key)[0].worktree!.path, "file.txt"), "utf8"), "retained Slack edit\n");
  const otherContext = { ...context, threadTs: "456.0" };
  await runtime.ask({ prompt: "Another question", transcript: [], context: otherContext });
  const otherKey = workspaces.conversationKey(workspaces.slackConversation(context.teamId, context.channelId, otherContext.threadTs));
  assert.notEqual(workspaces.conversationSession(otherKey), session);
});

test("Slack abort and timeout cancel cloud work, and pre-aborted requests enqueue nothing", async () => {
  const { FlowRuntime } = await import("../src/slack-agent/runtime.js");
  const context = { surface: "dm" as const, teamId: "T-active", channelId: "D-active", threadTs: "789.0", userId: "U1" };
  const query = { prompt: "Edit retries", transcript: [], context };
  const controller = new AbortController();
  const pending = new FlowRuntime().ask({ ...query, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  const key = workspaces.conversationKey(workspaces.slackConversation(context.teamId, context.channelId, context.threadTs));
  const rows = () => db.prepare("SELECT id FROM jobs WHERE json_extract(input, '$.conversation_key') = ? ORDER BY rowid")
    .all(key) as { id: string }[];
  assert.equal(rows().length, 1);
  assert.equal(jobs.getJob(rows()[0].id)!.status, "failed");
  await assert.rejects(new FlowRuntime().ask({ ...query, signal: controller.signal }), { name: "AbortError" });
  assert.equal(rows().length, 1);
  await assert.rejects(new FlowRuntime(0).ask(query), /timed out/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows().length, 2);
  assert.equal(jobs.getJob(rows()[1].id)!.status, "failed");
  assert.equal(workspaces.conversationSession(key), undefined);
});

test("workspace RPC accepts only its running job token and fixes the conversation server-side", async () => {
  const { key } = context();
  const id = "workspace-rpc-job";
  db.prepare("INSERT INTO jobs (id, type, input, status) VALUES (?, 'answer', ?, 'running')")
    .run(id, JSON.stringify({ conversation_key: key }));
  const request = (token: string, payload = {}) => app.inject({
    method: "POST", url: `/v1/agents/tasks/${id}/workspace`, payload,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await request("cloud-test-admin")).statusCode, 401);
  assert.equal((await request(jobs.jobScopedToken("another-job"))).statusCode, 401);
  assert.equal((await request(jobs.jobScopedToken(id))).statusCode, 200);
  const result = await request(jobs.jobScopedToken(id), { repo: "api", edit: true, conversation_key: "somebody-else" });
  assert.equal(result.statusCode, 200);
  assert.ok(workspaces.conversationRepos(key)[0].worktree);
  db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(id);
  (await import("../src/agents/coding-slot.js")).releaseCodingSlot(id);
  assert.equal((await request(jobs.jobScopedToken(id))).statusCode, 403);
});

test("checkpoint deletes the worktree, keeps local changes, and restores the same conversation", async () => {
  const { cleanupConversation } = await import("../src/agents/cloud-cleanup.js");
  const { key } = context();
  workspaces.bindConversation(key, "checkpoint-session");
  const repo = await workspaces.ensureConversationWorktree(key, "api");
  const tree = repo.worktree!.path;
  writeFileSync(path.join(tree, "file.txt"), "checkpoint edit\n");
  writeFileSync(path.join(tree, "new.txt"), "new file\n");
  assert.deepEqual(await cleanupConversation(key), { archived: 1, retained: 0 });
  assert.equal(existsSync(tree), false);
  const saved = workspaces.conversationRepos(key)[0].worktree!;
  assert.ok(saved.archived_at);
  assert.equal(git(source("api"), "show", `${saved.branch}:file.txt`), "checkpoint edit");
  assert.equal(readFileSync(path.join(source("api"), "file.txt"), "utf8"), "base\n");
  await workspaces.restoreConversationWorktrees(key);
  assert.equal(workspaces.conversationSession(key), "checkpoint-session");
  assert.equal(readFileSync(path.join(tree, "new.txt"), "utf8"), "new file\n");
  assert.equal(git(tree, "status", "--porcelain"), "");
  // A second archive/recreate cycle must preserve the checkpoint branch too.
  assert.deepEqual(await cleanupConversation(key), { archived: 1, retained: 0 });
  await workspaces.restoreConversationWorktrees(key);
  assert.equal(readFileSync(path.join(tree, "file.txt"), "utf8"), "checkpoint edit\n");
});

test("Git identity follows a moved tree and detached HEAD instead of trusting the old path", async () => {
  const { cleanupConversation } = await import("../src/agents/cloud-cleanup.js");
  const { key } = context();
  const repo = await workspaces.ensureConversationWorktree(key, "api");
  const old = repo.worktree!.path;
  const moved = old + "-moved";
  git(source("api"), "worktree", "move", old, moved);
  git(moved, "checkout", "--detach");
  writeFileSync(path.join(moved, "file.txt"), "detached edit\n");
  await workspaces.reconcileConversation(key);
  assert.equal(workspaces.conversationRepos(key)[0].worktree!.path, realpathSync(moved));
  assert.equal(workspaces.conversationRepos(key)[0].worktree!.branch, "");
  assert.deepEqual(await cleanupConversation(key), { archived: 1, retained: 0 });
  await workspaces.restoreConversationWorktrees(key);
  assert.equal(readFileSync(path.join(moved, "file.txt"), "utf8"), "detached edit\n");
});

test("cleanup retains unknown ignored files, changed secrets, and partial staging", async () => {
  const { cleanupConversation } = await import("../src/agents/cloud-cleanup.js");
  for (const kind of ["ignored", "secret", "staged"] as const) {
    const { key } = context();
    const tree = (await workspaces.ensureConversationWorktree(key, "api")).worktree!.path;
    if (kind === "ignored") {
      writeFileSync(path.join(tree, ".gitignore"), "database.sqlite\n");
      writeFileSync(path.join(tree, "database.sqlite"), "important local state");
    } else if (kind === "secret") writeFileSync(path.join(tree, ".env"), "PASSWORD=local-only\n");
    else {
      writeFileSync(path.join(tree, "file.txt"), "staged\n");
      git(tree, "add", "file.txt");
      writeFileSync(path.join(tree, "file.txt"), "unstaged\n");
    }
    assert.deepEqual(await cleanupConversation(key), { archived: 0, retained: 1 });
    assert.ok(existsSync(tree));
    assert.ok(workspaces.conversationRepos(key)[0].worktree!.cleanup_error);
    if (kind === "staged") assert.equal(git(tree, "show", ":file.txt"), "staged");
  }
});

test("known caches and unchanged copied env files can be removed and restored", async () => {
  const { cleanupConversation } = await import("../src/agents/cloud-cleanup.js");
  const { key } = context();
  writeFileSync(path.join(source("api"), ".env"), "EXAMPLE=local\n");
  try {
    const tree = (await workspaces.ensureConversationWorktree(key, "api")).worktree!.path;
    writeFileSync(path.join(tree, ".gitignore"), ".env\nnode_modules/\n");
    mkdirSync(path.join(tree, "node_modules"));
    writeFileSync(path.join(tree, "node_modules", "cache"), "rebuildable");
    assert.deepEqual(await cleanupConversation(key), { archived: 1, retained: 0 });
    await workspaces.restoreConversationWorktrees(key);
    assert.equal(readFileSync(path.join(tree, ".env"), "utf8"), "EXAMPLE=local\n");
    assert.equal(existsSync(path.join(tree, "node_modules")), false);
  } finally { rmSync(path.join(source("api"), ".env")); }
});

test("coding requests are FIFO while ordinary answer jobs still finish", async () => {
  const { requestCodingSlot, releaseCodingSlot } = await import("../src/agents/coding-slot.js");
  assert.equal(requestCodingSlot("coding-one").acquired, true);
  assert.equal(requestCodingSlot("coding-two").acquired, false);
  assert.equal(requestCodingSlot("coding-three").position, 2);
  try {
    const { id } = await jobs.enqueueJob({ type: "answer", input: { question: "plain question" } });
    assert.equal((await finished(id)).status, "done");
    releaseCodingSlot("coding-two"); // cancelled waiter doesn't block the next
    assert.equal(requestCodingSlot("coding-three").position, 1);
    releaseCodingSlot("coding-one");
    assert.equal(requestCodingSlot("coding-three").acquired, true);
  } finally { for (const id of ["coding-one", "coding-two", "coding-three"]) releaseCodingSlot(id); }
});

test("resumed direct edits and bash acquire the slot but reads do not", async () => {
  const { key } = context();
  const tree = (await workspaces.ensureConversationWorktree(key, "api")).worktree!.path;
  let acquired = 0;
  const guard = createCloudToolPolicy({ directory: root, repos: async () => workspaces.conversationRepos(key),
    ensure: (name) => workspaces.ensureConversationWorktree(key, name), acquire: async () => { acquired++; } });
  await guard("read", { filePath: path.join(tree, "file.txt") });
  assert.equal(acquired, 0);
  await guard("edit", { filePath: path.join(tree, "file.txt") });
  await guard("bash", { workdir: tree, command: "npm test" });
  assert.equal(acquired, 2);
  await assert.rejects(guard("bash", { workdir: tree, command: "npm install -g example" }));
});

test("cleanup skips an active conversation and a busy machine", async () => {
  const { cleanupConversation } = await import("../src/agents/cloud-cleanup.js");
  const { requestCodingSlot, releaseCodingSlot } = await import("../src/agents/coding-slot.js");
  const { key } = context();
  const tree = (await workspaces.ensureConversationWorktree(key, "api")).worktree!.path;
  db.prepare("INSERT INTO jobs (id,type,input,status) VALUES ('active-cleanup-test','answer',?,'running')").run(JSON.stringify({ conversation_key: key }));
  assert.deepEqual(await cleanupConversation(key), { archived: 0, retained: 0 });
  db.prepare("UPDATE jobs SET status = 'done' WHERE id = 'active-cleanup-test'").run();
  requestCodingSlot("busy-cleanup-test");
  try { assert.deepEqual(await cleanupConversation(key), { archived: 0, retained: 0 }); }
  finally { releaseCodingSlot("busy-cleanup-test"); }
  assert.ok(existsSync(tree));
});

test("a different linked worktree at the same path is never adopted or deleted", async () => {
  const { cleanupConversation } = await import("../src/agents/cloud-cleanup.js");
  const { key } = context();
  const tree = (await workspaces.ensureConversationWorktree(key, "api")).worktree!.path;
  git(source("api"), "worktree", "remove", tree);
  git(source("api"), "worktree", "add", "--detach", tree, "HEAD");
  await assert.rejects(workspaces.ensureConversationWorktree(key, "api"), /missing or replaced/);
  assert.deepEqual(await cleanupConversation(key), { archived: 0, retained: 1 });
  assert.ok(existsSync(tree));
});

test("independent orchestrators share the slot and recover a dead owner", { timeout: 10_000 }, async () => {
  const { requestCodingSlot, releaseCodingSlot } = await import("../src/agents/coding-slot.js");
  const module = new URL("../src/agents/coding-slot.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", `
    const { requestCodingSlot } = await import(${JSON.stringify(module)});
    console.log(JSON.stringify(requestCodingSlot('external-owner')));
    setInterval(() => {}, 1000);
  `], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const first = await new Promise<string>((resolve, reject) => {
      child.stdout.once("data", (d) => resolve(String(d)));
      child.once("error", reject);
      child.once("exit", () => reject(new Error("worker exited before admission")));
    });
    assert.equal(JSON.parse(first).acquired, true);
    assert.equal(requestCodingSlot("other-project").acquired, false);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL"); await exited;
    assert.equal(requestCodingSlot("other-project").acquired, true);
  } finally { child.kill("SIGKILL"); releaseCodingSlot("other-project"); }
});

test("Linux crash recovery kills the orphan coding process group before admitting another task", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
  const { requestCodingSlot, releaseCodingSlot } = await import("../src/agents/coding-slot.js");
  const module = new URL("../src/agents/coding-slot.ts", import.meta.url).href;
  const owner = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    const { requestCodingSlot } = await import(${JSON.stringify(module)});
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    requestCodingSlot('orphan-owner', worker.pid);
    console.log(worker.pid);
    setInterval(() => {}, 1000);
  `], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let pid: number | undefined;
  try {
    pid = Number(await new Promise<string>((resolve, reject) => { owner.stdout.once("data", (d) => resolve(String(d))); owner.once("error", reject); }));
    assert.ok(pid > 0);
    const exited = new Promise((resolve) => owner.once("exit", resolve));
    owner.kill("SIGKILL"); await exited;
    let acquired = false;
    for (let i = 0; i < 30 && !acquired; i++) {
      acquired = requestCodingSlot("after-orphan").acquired;
      if (!acquired) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(acquired, true);
    let state = "gone";
    try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]; } catch {}
    assert.ok(state === "gone" || state === "Z");
  } finally {
    owner.kill("SIGKILL");
    if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
    releaseCodingSlot("after-orphan");
  }
});

test("Slack command mentions and duplicate delivery use one conversation", async () => {
  const { executeAuto } = await import("../src/actions/index.js");
  const { processEvent } = await import("../src/events.js");
  const payload = { text: "Fix retries", channel: "C1", ts: "100.0" };
  const event = { id: "slack-command", source: "slack" as const, type: "mention", ts: 100_000, workspace: "T1", payload };
  await executeAuto({ event, classification: { classification: "command", confidence: 1, extracted: {} }, policy: "auto" });
  const ref = workspaces.slackConversation("T1", "C1", "100.0");
  assert.ok(workspaces.hasConversation(ref));
  const reply = { ...event, id: "slack-followup", type: "ambient", payload: { ...payload, text: "Also update tests", ts: "101.0", thread_ts: "100.0" } };
  await processEvent(reply);
  await processEvent(reply);
  const rows = db.prepare("SELECT id FROM jobs WHERE json_extract(input, '$.conversation_key') = ? ORDER BY rowid")
    .all(workspaces.conversationKey(ref)) as { id: string }[];
  assert.equal(rows.length, 2);
  const a = await finished(rows[0].id);
  const b = await finished(rows[1].id);
  assert.equal(a.session_id, b.session_id);
});

test("cloud mode blocks the unguarded ACP creation entry point", async () => {
  const { createSession } = await import("../src/agents/runtime.js");
  for (const backend of ["opencode", "codex", "claude"] as const) {
    const result = await createSession({ backend, repo: "api", prompt: "edit", placement: "in_place" });
    assert.ok("error" in result);
  }
});

test("restart recovery fails pending edits but preserves the session and worktree", async () => {
  const { key } = context();
  const repo = await workspaces.ensureConversationWorktree(key, "api");
  workspaces.bindConversation(key, "retained-session");
  for (const status of ["running", "queued"]) {
    db.prepare("INSERT INTO jobs (id, type, input, status) VALUES (?, 'answer', ?, ?)")
      .run(`restart-${status}`, JSON.stringify({ conversation_key: key }), status);
  }
  jobs.recoverStalledJobs();
  assert.equal(jobs.getJob("restart-running")!.status, "failed");
  assert.equal(jobs.getJob("restart-queued")!.status, "failed");
  assert.equal(workspaces.conversationSession(key), "retained-session");
  assert.equal(workspaces.conversationRepos(key)[0].worktree!.path, repo.worktree!.path);
});

test("repo env uploads are encrypted, scoped, refreshed between turns and excluded from checkpoints", async () => {
  const env = await import("../src/agents/repo-env.js");
  const headers = { authorization: "Bearer cloud-test-admin" };
  const secret = "unique-environment-value-984329";
  assert.equal((await app.inject({ method: "PUT", url: "/v1/agents/repos/api/env", payload: { filename: ".env.local", content: `APP_SECRET=${secret}\n` } })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: "/v1/agents/repos/api/env", headers, payload: { filename: "../.env", content: "BAD=1" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: "/v1/agents/repos/api/env", headers, payload: { filename: ".env.local", content: `APP_SECRET=${secret}\n` } })).statusCode, 200);
  const listed = await app.inject({ method: "GET", url: "/v1/agents/repos/api/env", headers });
  assert.ok(!listed.body.includes(secret));
  assert.ok(!(db.prepare("SELECT value FROM config WHERE key = ?").get("repo-env:api:.env.local") as { value: string }).value.includes(secret));
  const { key } = context();
  const repo = await workspaces.ensureConversationWorktree(key, "api");
  const tree = repo.worktree!;
  const file = path.join(tree.path, ".env.local");
  assert.equal(readFileSync(file, "utf8"), `APP_SECRET=${secret}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(path.join(source("api"), ".env.local")), false);
  const web = await workspaces.ensureConversationWorktree(key, "web");
  assert.equal(existsSync(path.join(web.worktree!.path, ".env.local")), false);
  assert.equal(env.redactCloudText(`value ${secret}`), "value [redacted]");
  env.saveRepoEnv("api", ".env.local", "APP_SECRET=second-secret-value\n");
  await workspaces.ensureConversationWorktree(key, "api");
  assert.ok(readFileSync(file, "utf8").includes(secret));
  await workspaces.ensureConversationWorktree(key, "api", true);
  assert.equal(readFileSync(file, "utf8"), "APP_SECRET=second-secret-value\n");
  writeFileSync(path.join(tree.path, "persist.txt"), "keep code\n");
  const { cleanupConversation } = await import("../src/agents/cloud-cleanup.js");
  assert.deepEqual(await cleanupConversation(key), { archived: 2, retained: 0 });
  const saved = workspaces.conversationRepos(key)[0].worktree!;
  assert.ok(!git(source("api"), "ls-tree", "-r", "--name-only", saved.checkpoint_commit!).includes(".env.local"));
  const restored = await workspaces.ensureConversationWorktree(key, "api", true);
  const restoredFile = path.join(restored.worktree!.path, ".env.local");
  assert.equal(readFileSync(path.join(restored.worktree!.path, "persist.txt"), "utf8"), "keep code\n");
  assert.equal(readFileSync(restoredFile, "utf8"), "APP_SECRET=second-secret-value\n");
  writeFileSync(restoredFile, "LOCAL=retain-me\n");
  env.saveRepoEnv("api", ".env.local", "REPLACEMENT=no\n");
  await assert.rejects(workspaces.ensureConversationWorktree(key, "api", true), /retained instead of overwritten/);
  assert.equal(readFileSync(restoredFile, "utf8"), "LOCAL=retain-me\n");
  assert.deepEqual(await cleanupConversation(key), { archived: 0, retained: 1 });
  env.removeRepoEnv("api", ".env.local");
});

test("env replacement rejects symlinks; removal restores original source env", async () => {
  const env = await import("../src/agents/repo-env.js");
  writeFileSync(path.join(source("api"), ".env"), "SOURCE=original\n");
  env.saveRepoEnv("api", ".env", "UPLOAD=replacement\n");
  const { key } = context();
  const repo = await workspaces.ensureConversationWorktree(key, "api");
  const file = path.join(repo.worktree!.path, ".env");
  env.removeRepoEnv("api", ".env");
  await workspaces.ensureConversationWorktree(key, "api", true);
  assert.equal(readFileSync(file, "utf8"), "SOURCE=original\n");
  rmSync(file); symlinkSync(path.join(source("api"), ".env"), file);
  env.saveRepoEnv("api", ".env", "UPLOAD=unsafe\n");
  await assert.rejects(workspaces.ensureConversationWorktree(key, "api", true), /not a regular file/);
  assert.equal(readFileSync(path.join(source("api"), ".env"), "utf8"), "SOURCE=original\n");
  env.removeRepoEnv("api", ".env"); rmSync(path.join(source("api"), ".env"));
});

test("cloud run API executes real commands and followups in the same tree with redacted output", async () => {
  const headers = { authorization: "Bearer cloud-test-admin" };
  const initial = await app.inject({ method: "POST", url: "/v1/agents/tasks", headers, payload: { message: "hello", conversation: { source: "dashboard", id: "command-test" } } });
  const id = initial.json().id;
  const first = await finished(id);
  const session = first.session_id;
  const command = async (text: string) => {
    const response = await app.inject({ method: "POST", url: `/v1/agents/tasks/${id}/command`, headers, payload: { repo: "api", command: text } });
    assert.equal(response.statusCode, 202, response.body);
    return finished(response.json().id);
  };
  const edited = await command(`node -e 'require("fs").writeFileSync("command-result.txt", "first"); console.log("actual-command-output")'`);
  assert.equal(edited.status, "done", edited.result_json ?? "");
  assert.equal(JSON.parse(edited.result_json!).exit_code, 0);
  assert.ok(JSON.parse(edited.result_json!).output.includes("actual-command-output"));
  assert.equal(edited.session_id, session);
  const followed = await command(`node -e 'const fs=require("fs"); if(fs.readFileSync("command-result.txt","utf8")!=="first")process.exit(7); fs.appendFileSync("command-result.txt", "-second")'`);
  assert.equal(JSON.parse(followed.result_json!).exit_code, 0);
  assert.equal(existsSync(path.join(source("api"), "command-result.txt")), false);
  const failed = await command("node -e 'process.exit(9)'");
  assert.equal(JSON.parse(failed.result_json!).exit_code, 9);
  const detail = await app.inject({ method: "GET", url: `/v1/agents/tasks/${id}`, headers });
  assert.equal(detail.json().turns.length, 4);
  assert.ok(detail.json().turns[1].events.length);
  const list = await app.inject({ method: "GET", url: "/v1/agents/tasks", headers });
  assert.ok(list.json().tasks.some((task: { id: string }) => task.id === failed.id));
  assert.equal((await app.inject({ method: "GET", url: `/v1/agents/tasks/${id}` })).statusCode, 401);
});

test("manual commands queue across conversations while questions finish; cancellation stops execution", async () => {
  const headers = { authorization: "Bearer cloud-test-admin" };
  const { codingSlotStatus } = await import("../src/agents/coding-slot.js");
  const create = async (name: string) => { const response = await app.inject({ method: "POST", url: "/v1/agents/tasks", headers, payload: { message: "hello", conversation: { source: "dashboard", id: name } } }); await finished(response.json().id); return response.json().id; };
  const a = await create("queue-command-a"), b = await create("queue-command-b");
  const start = async (id: string, command: string) => (await app.inject({ method: "POST", url: `/v1/agents/tasks/${id}/command`, headers, payload: { repo: "api", command } })).json().id as string;
  const first = await start(a, "node -e 'setTimeout(()=>console.log(123),30000)'");
  for (let i = 0; i < 100 && codingSlotStatus(first) !== "coding"; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(codingSlotStatus(first), "coding");
  const second = await start(b, "node -e 'require(\"fs\").writeFileSync(\"queued-must-not-run.txt\",\"bad\")'");
  for (let i = 0; i < 100 && codingSlotStatus(second) !== "waiting"; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(codingSlotStatus(second), "waiting");
  await create("question-during-command");
  assert.equal(jobs.getJob(first)!.status, "running");
  assert.equal(jobs.getJob(second)!.status, "running");
  await app.inject({ method: "POST", url: `/v1/agents/tasks/${second}/cancel`, headers, payload: {} });
  await app.inject({ method: "POST", url: `/v1/agents/tasks/${first}/cancel`, headers, payload: {} });
  await finished(first); await finished(second);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(codingSlotStatus(first), undefined);
  assert.equal(codingSlotStatus(second), undefined);
  const detail = (await app.inject({ method: "GET", url: `/v1/agents/tasks/${b}`, headers })).json();
  const tree = detail.repos.find((r: { name: string }) => r.name === "api").worktree;
  assert.ok(!tree || !existsSync(path.join(tree.path, "queued-must-not-run.txt")));
});

test("uploaded env secrets are redacted from real terminal results and activity", async () => {
  const env = await import("../src/agents/repo-env.js");
  const headers = { authorization: "Bearer cloud-test-admin" };
  env.saveRepoEnv("web", ".env.local", "PASSWORD=terminal-secret-8726929\n");
  const initial = await app.inject({ method: "POST", url: "/v1/agents/tasks", headers, payload: { message: "hello", conversation: { source: "dashboard", id: "redact-command" } } });
  const id = initial.json().id; await finished(id);
  const response = await app.inject({ method: "POST", url: `/v1/agents/tasks/${id}/command`, headers, payload: { repo: "web", command: "node -e 'console.log(require(\"fs\").readFileSync(\".env.local\",\"utf8\"))'" } });
  const done = await finished(response.json().id);
  assert.equal(JSON.parse(done.result_json!).exit_code, 0);
  assert.ok(!done.result_json!.includes("terminal-secret-8726929"));
  assert.ok(done.result_json!.includes("[redacted]"));
  const detail = await app.inject({ method: "GET", url: `/v1/agents/tasks/${id}`, headers });
  assert.ok(!detail.body.includes("terminal-secret-8726929"));
  env.removeRepoEnv("web", ".env.local");
});

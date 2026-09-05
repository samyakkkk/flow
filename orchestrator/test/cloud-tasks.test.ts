import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createCloudToolPolicy, patchPaths } from "../src/agents/cloud-tool-policy.js";

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
  await assert.rejects(workspaces.ensureConversationWorktree(key, "api"), /ENOENT/);
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

test("shell requires an explicit owned worktree and refuses direct source/branch operations", async () => {
  const { key, policy } = context();
  await assert.rejects(policy("bash", { command: "git checkout other", workdir: source("api") }), /existing conversation worktree/);
  assert.equal(workspaces.conversationRepos(key).filter((r) => r.worktree).length, 0);
  const repo = await workspaces.ensureConversationWorktree(key, "api");
  const workdir = repo.worktree!.path;
  await assert.rejects(policy("bash", { command: "npm test" }), /explicit repository path/);
  for (const command of [
    `git -C ${source("api")} checkout other`, "git switch main", "git worktree remove ../other",
    `cd ${source("api")} && npm test`, `echo x > ${source("api")}/file.txt`,
    "git --git-dir=../repo/.git reset --hard", "GIT_WORK_TREE=../repo git reset --hard",
    "'git' 'switch' main", "g\\it check\\out main",
  ]) await assert.rejects(policy("bash", { command, workdir }), /without changing/);
  await policy("bash", { command: "npm test", workdir });
  await policy("bash", { command: "git diff --stat", workdir });
  await policy("bash", { command: "git add . && git commit -m 'Fix behavior'", workdir });
});

test("unknown tools, delegated agents and graph mutations fail closed", async () => {
  const { policy } = context();
  for (const name of ["task", "batch", "shell", "graph_upsert_entity", "new_editor"]) {
    await assert.rejects(policy(name, {}), /not enabled/);
  }
  await policy("graph_search_knowledge", {});
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
  assert.equal((await request(jobs.jobScopedToken(id))).statusCode, 403);
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

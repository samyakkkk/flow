import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";

const root = mkdtempSync(path.join(tmpdir(), "flow-setup-test-"));
Object.assign(process.env, { DB_PATH: ":memory:", FLOW_MODE: "prod", FLOW_ADMIN_TOKEN: "test-admin", FLOW_PUBLIC_URL: "https://flow.example/project", FLOW_FAKE_OPENCODE: "1", FLOW_DRAIN_DISABLE: "1", OPENCODE_WORKSPACE_DIR: root, REPOS_JSON_PATH: path.join(root, "repos.json"), FLOW_CODING_STATE_DIR: path.join(root, "queue"), GATEWAY_URL: "http://127.0.0.1:1", FLOW_EMBED_URL: "http://127.0.0.1:1", SLACK_BOT_TOKEN: "test-bot" });
const source = path.join(root, "repos", "demo");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
let files: typeof import("../src/agents/setup-files.js");
let requests: typeof import("../src/agents/setup-requests.js");
let workspaces: typeof import("../src/agents/cloud-workspaces.js");
let queue: typeof import("../src/agents/coding-slot.js");
let jobs: typeof import("../src/opencode.js");
let worker: typeof import("../src/agents/setup-worker.js");
let terminal: typeof import("../src/agents/setup-terminal.js");
let db: typeof import("../src/db.js").default;
const app = Fastify();
const realFetch = globalThis.fetch;
const messages: Record<string, any>[] = [];
let downloads = 0;
let downloadUrl = "https://files.slack.com/test-config";
let fileContent = Buffer.from('{"password":"private-test-value"}');
let serial = 0;
const fresh = async (name = String(++serial)) => {
  const key = workspaces.conversationKey(workspaces.slackConversation("TTEST", "CTEST", name));
  workspaces.ensureConversation(key);
  files.setupEnvironment(key, "demo", "staging");
  const repo = await workspaces.ensureConversationWorktree(key, "demo");
  return { key, repo, tree: repo.worktree!.path };
};
function insertJob(id: string, key: string, status = "running") {
  db.prepare("INSERT INTO jobs (id,type,input,status) VALUES (?,'answer',?,?)").run(id, JSON.stringify({ conversation_key: key, question: "Run the app", slack_requester: "UORIGINAL" }), status);
}
before(async () => {
  mkdirSync(source, { recursive: true });
  git(source, "init", "-q", "-b", "main"); git(source, "config", "user.name", "Test"); git(source, "config", "user.email", "test@example.com");
  writeFileSync(path.join(source, "tracked.json"), "{}\n"); git(source, "add", "."); git(source, "commit", "-qm", "base");
  writeFileSync(process.env.REPOS_JSON_PATH!, JSON.stringify({ repos: [{ name: "demo", branch: "main" }] }));
  files = await import("../src/agents/setup-files.js"); requests = await import("../src/agents/setup-requests.js"); workspaces = await import("../src/agents/cloud-workspaces.js");
  queue = await import("../src/agents/coding-slot.js"); jobs = await import("../src/opencode.js"); worker = await import("../src/agents/setup-worker.js"); terminal = await import("../src/agents/setup-terminal.js"); db = (await import("../src/db.js")).default;
  app.addHook("onRequest", (await import("../src/auth.js")).requireAuth);
  (await import("../src/agents/setup-routes.js")).registerSetupRoutes(app);
  await app.ready();
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.startsWith("https://slack.com/api/")) {
      const args = JSON.parse(String(options?.body ?? "{}"));
      if (target.includes("conversations.info?")) return Response.json({ ok: true, channel: { id: "CTEST", is_ext_shared: false } });
      if (target.endsWith("conversations.open")) { assert.equal(args.users, "UORIGINAL"); return Response.json({ ok: true, channel: { id: "DTEST" } }); }
      if (target.endsWith("chat.postMessage")) { messages.push(args); return Response.json({ ok: true, ts: `${messages.length}.001` }); }
      if (target.includes("files.info?")) { assert.equal(options?.method, "GET"); assert.equal(new URL(target).searchParams.get("file"), "FTEST"); return Response.json({ ok: true, file: { size: fileContent.length, url_private: downloadUrl } }); }
    }
    if (target === "https://files.slack.com/test-config") { downloads++; assert.equal(options?.redirect, "error"); return new Response(fileContent); }
    return realFetch(url, options);
  };
});
after(async () => {
  terminal.stopSetupTerminals();
  for (const row of db.prepare("SELECT id FROM jobs WHERE status IN ('running','queued')").all() as { id: string }[]) jobs.cancelCloudJob(row.id);
  for (const id of ["setup-parent", "second-task", "other-coding", "next-coding", "after-setup-pause"]) queue.releaseCodingSlot(id);
  await new Promise(resolve => setTimeout(resolve, 100));
  globalThis.fetch = realFetch; await app.close(); rmSync(root, { recursive: true, force: true });
});

test("arbitrary nested setup files persist privately to source/current/future worktrees and never enter Git", async () => {
  const { key, tree } = await fresh();
  files.registerSetupFile({ repo: "demo", environment: "staging", destination: "services/api/.state.env", data: Buffer.from("TEST_KEY=private-state-value\n"), source, worktree: tree, conversation: key });
  for (const cwd of [source, tree]) { assert.equal(readFileSync(path.join(cwd, "services/api/.state.env"), "utf8"), "TEST_KEY=private-state-value\n"); assert.equal(statSync(path.join(cwd, "services/api/.state.env")).mode & 0o777, 0o600); assert.equal(git(cwd, "status", "--porcelain"), ""); }
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM config").all()).includes("private-state-value"));
  const next = await fresh(); assert.ok(existsSync(path.join(next.tree, "services/api/.state.env")));
  assert.equal(files.unchangedSetupFile("demo", tree, "services/api/.state.env"), true);
  writeFileSync(path.join(tree, "services/api/.state.env"), "user change");
  assert.throws(() => files.applySetupFiles(key, "demo", tree), /changed locally/);
  assert.equal(readFileSync(path.join(tree, "services/api/.state.env"), "utf8"), "user change");
});
test("rejects tracked destinations, traversal, symlinks and oversized files", async () => {
  const { key, tree } = await fresh();
  const save = (destination: string, data = Buffer.from("x")) => files.registerSetupFile({ repo: "demo", environment: "staging", destination, data, source, worktree: tree, conversation: key });
  for (const invalid of ["../outside", "/tmp/config", ".git/config", "a/../../b", "a//b"]) assert.throws(() => save(invalid), /repository-relative/);
  assert.throws(() => save("tracked.json"), /tracked by Git/);
  symlinkSync(root, path.join(tree, "escape")); assert.throws(() => save("escape/stolen"), /symlinks/);
  assert.throws(() => save("huge", Buffer.alloc(files.MAX_SETUP_BYTES + 1)), /1 MiB/);
});
test("separate environments are pinned per conversation; production is never an implicit default", async () => {
  const a = await fresh();
  files.registerSetupFile({ repo: "demo", environment: "production", destination: "config/runtime.json", data: Buffer.from('{"host":"production"}'), source, worktree: a.tree, conversation: a.key });
  const b = await fresh(); assert.equal(files.setupEnvironment(b.key, "demo"), "staging"); assert.equal(existsSync(path.join(b.tree, "config/runtime.json")), false);
  const raw = files.setupFiles("demo").find(f => f.environment === "production")!;
  db.prepare("INSERT INTO config(key,value) VALUES (?,?)").run('setup-file:only-production', JSON.stringify({ ...raw, repo: "only-prod" }));
  assert.throws(() => files.setupEnvironment("new-conversation", "only-prod"), /Choose a setup environment/);
});
test("single variable setup preserves unrelated env entries and refuses ambiguous replacement", async () => {
  writeFileSync(path.join(source, "values.env"), "EXISTING=keep\n");
  const merged = files.mergeSetupValue(source, "values.env", "MISSING", Buffer.from('MISSING="new"\n')).toString();
  assert.equal(merged, 'EXISTING=keep\nMISSING="new"\n');
  assert.throws(() => files.mergeSetupValue(source, "values.env", "EXISTING", Buffer.from("EXISTING=new")), /already exists/);
});
test("job-scoped request DMs original requester, pauses, releases slot, receives privately, resumes same thread exactly once", async () => {
  const { key } = await fresh("slack-request"); insertJob("setup-parent", key);
  queue.requestCodingSlot("setup-parent");
  const bad = await app.inject({ method: "POST", url: "/v1/agents/tasks/setup-parent/setup", headers: { authorization: "Bearer wrong" }, payload: { action: "list", repo: "demo" } }); assert.equal(bad.statusCode, 401);
  const response = await app.inject({ method: "POST", url: "/v1/agents/tasks/setup-parent/setup", headers: { authorization: `Bearer ${jobs.jobScopedToken("setup-parent")}` }, payload: { action: "request", repo: "demo", environment: "staging", kind: "file", destination: "services/config.json", reason: "The app needs its staging configuration" } });
  assert.equal(response.statusCode, 200, response.body);
  const id = response.json().request; let request = requests.getSetupRequest(id)!;
  assert.equal(request.requester, "UORIGINAL"); assert.equal(request.dm, "DTEST");
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(jobs.getJob("setup-parent")!.status, "done");
  // No child in this unit fixture, so mirror runJob's finally. The real CLI smoke covers process exit.
  queue.releaseCodingSlot("setup-parent");
  assert.equal(queue.requestCodingSlot("second-task").acquired, true);
  const reply = { team: "TTEST", channel: "DTEST", thread: request.dmThread!, user: "UORIGINAL", text: "", files: [{ id: "FTEST" }] };
  assert.equal(await requests.receiveSetupReply({ ...reply, user: "UOTHER" }), true); assert.equal(downloads, 0);
  assert.equal(await requests.receiveSetupReply({ ...reply, team: "TOTHER" }), false);
  await requests.receiveSetupReply(reply); await requests.receiveSetupReply(reply); assert.equal(downloads, 1);
  assert.ok(!JSON.stringify(messages).includes("private-test-value"));
  await worker.sweepSetupRequests(); assert.equal(requests.getSetupRequest(id)!.state, "ready");
  queue.releaseCodingSlot("second-task"); await worker.sweepSetupRequests();
  request = requests.getSetupRequest(id)!; assert.equal(request.state, "resumed"); assert.ok(request.resumeJob);
  const resumed = jobs.getJob(request.resumeJob!)!; assert.equal(resumed.input.conversation_key, key); assert.equal(resumed.input.reply_to, undefined, "The setup worker owns final delivery, not the legacy outbox");
  assert.ok(!JSON.stringify(resumed).includes("private-test-value"));
  assert.equal(readFileSync(path.join(source, "services/config.json"), "utf8"), fileContent.toString());
  await worker.sweepSetupRequests(); assert.equal((db.prepare("SELECT count(*) AS count FROM jobs WHERE json_extract(input,'$.setup_request') = ?").get(id) as { count: number }).count, 1);
  for (let i = 0; i < 500 && jobs.getJob(request.resumeJob!)?.status !== "done"; i++) await new Promise(resolve => setTimeout(resolve, 20));
  await worker.sweepSetupRequests(); await worker.sweepSetupRequests();
  const delivered = messages.filter(m => m.client_msg_id === request.resumeJob);
  assert.equal(delivered.length, 1); assert.equal(delivered[0].channel, "CTEST"); assert.equal(delivered[0].thread_ts, "slack-request");
  assert.equal(requests.getSetupRequest(id)!.delivered, true);
});
test("setup upload rejects external URLs and cancellation prevents resume", async () => {
  const { key } = await fresh(); insertJob("cancel-parent", key, "done");
  const request = await requests.createSetupRequest({ job: "cancel-parent", conversation: key, requester: "UORIGINAL", team: "TTEST", channel: "CTEST", thread: "cancel", repo: "demo", environment: "staging", destination: "extra.cfg", kind: "file", reason: "Need config" });
  downloadUrl = "https://attacker.example/file";
  const reply = { team: "TTEST", channel: request.dm!, thread: request.dmThread!, user: "UORIGINAL", text: "", files: [{ id: "FTEST" }] };
  await requests.receiveSetupReply(reply); assert.equal(requests.getSetupRequest(request.id)!.state, "waiting"); downloadUrl = "https://files.slack.com/test-config";
  await requests.receiveSetupReply({ ...reply, text: "cancel", files: [] }); await worker.sweepSetupRequests(); assert.equal(requests.getSetupRequest(request.id)!.state, "cancelled");
});
test("interactive terminal shares the coding queue, accepts interactive input, and releases on completion", async () => {
  const { key } = await fresh(); insertJob("terminal-parent", key, "done");
  const request = await requests.createSetupRequest({ job: "terminal-parent", conversation: key, requester: "UORIGINAL", team: "TTEST", channel: "CTEST", thread: "terminal", repo: "demo", environment: "staging", kind: "terminal", reason: "Install a test CLI" });
  const unauthorized = await app.inject({ method: "GET", url: `/v1/agents/setup/${request.id}` }); assert.equal(unauthorized.statusCode, 401);
  queue.requestCodingSlot("other-coding"); assert.equal((await terminal.openSetupTerminal(request.id)).queued, true);
  queue.releaseCodingSlot("other-coding"); assert.equal((await terminal.openSetupTerminal(request.id)).queued, false);
  assert.equal(queue.requestCodingSlot("next-coding").acquired, false);
  const marker = path.join(root, "terminal-input.txt");
  terminal.writeSetupTerminal(request.id, `read -r reply; printf '%s' "$reply" > '${marker}'\r`);
  terminal.writeSetupTerminal(request.id, "interactive-answer\r");
  for (let i = 0; i < 500 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(readFileSync(marker, "utf8"), "interactive-answer");
  const foreground = path.join(root, "foreground.pid");
  if (process.platform === "linux") {
    terminal.writeSetupTerminal(request.id, `sh -c 'echo $$ > "${foreground}"; exec sleep 60'\r`);
    for (let i = 0; i < 500 && !existsSync(foreground); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(foreground));
  }
  terminal.closeSetupTerminal(request.id, true);
  for (let i = 0; i < 500 && !queue.requestCodingSlot("next-coding").acquired; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(queue.requestCodingSlot("next-coding").acquired, true); queue.releaseCodingSlot("next-coding");
  assert.equal(requests.getSetupRequest(request.id)!.state, "ready");
  if (process.platform === "linux") {
    const pid = readFileSync(foreground, "utf8").trim();
    const stat = `/proc/${pid}/stat`;
    assert.ok(!existsSync(stat) || readFileSync(stat, "utf8").split(") ")[1].startsWith("Z"), "Foreground process survived terminal close");
  }
});

test("setup pause stops a real coding subprocess and releases its slot without human input", async () => {
  const { key } = await fresh("pause-real-child");
  const [sourceType, workspace, id] = JSON.parse(key);
  const parent = await jobs.enqueueJob({ type: "answer", input: { conversation: { source: sourceType, workspace, id }, question: "Wait for setup", slack_requester: "UORIGINAL", manual_command: { repo: "demo", command: "sleep 60" } } });
  for (let i = 0; i < 1000 && !jobs.codingChildPid(parent.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(jobs.codingChildPid(parent.id));
  const response = await app.inject({ method: "POST", url: `/v1/agents/tasks/${parent.id}/setup`, headers: { authorization: `Bearer ${jobs.jobScopedToken(parent.id)}` }, payload: { action: "request", repo: "demo", environment: "staging", kind: "file", destination: "pause.cfg", reason: "Need a test configuration" } });
  assert.equal(response.statusCode, 200, response.body);
  for (let i = 0; i < 1000 && jobs.codingChildPid(parent.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(jobs.codingChildPid(parent.id), undefined);
  assert.equal(jobs.getJob(parent.id)!.status, "done");
  assert.match(jobs.getJob(parent.id)!.result_json!, /setup_wait/);
  for (let i = 0; i < 500 && !queue.requestCodingSlot("after-setup-pause").acquired; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(queue.requestCodingSlot("after-setup-pause").acquired, true);
  queue.releaseCodingSlot("after-setup-pause");
});

function seedNotificationRequest(id: string, delivered = false) {
  db.exec("DELETE FROM setup_requests");
  insertJob(`resume-${id}`, "fixture", "done");
  db.prepare("UPDATE jobs SET result_json=? WHERE id=?").run(JSON.stringify({ answer_md: "Saved task result" }), `resume-${id}`);
  requests.saveSetupRequest({ id, job: `parent-${id}`, resumeJob: `resume-${id}`, conversation: "fixture",
    requester: "UORIGINAL", team: "TTEST", channel: "CTEST", thread: "original",
    dm: "DTEST", dmThread: "setup", repo: "demo", environment: "staging", kind: "file",
    destination: "config.json", reason: "test", state: "resumed", delivered, notice: delivered ? "done" : "running", createdAt: Date.now() });
}

test("completed legacy setup requests perform no Slack calls across repeated sweeps", async () => {
  seedNotificationRequest("legacy-notification", true);
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Slack unavailable"); };
  try {
    for (let i=0;i<20;i++) await worker.sweepSetupRequests();
    assert.equal(calls,0);
    assert.equal(requests.getSetupRequest("legacy-notification")!.state,"completed");
  } finally { globalThis.fetch=fetch; }
});

test("delivery failures back off, notify at most once, and retire after successful private delivery", async () => {
  const id="delivery-retry";
  seedNotificationRequest(id);
  const fetch=globalThis.fetch;
  let infoCalls=0;
  let mode="rate";
  const sent: Record<string,any>[]=[];
  globalThis.fetch=async (url, options) => {
    if(String(url).includes("conversations.info")) {
      infoCalls++;
      if(mode==="rate") return Response.json({ok:false,error:"ratelimited"},{status:429,headers:{"retry-after":"120"}});
      if(mode==="error") return Response.json({ok:false,error:"channel_not_found"});
      return Response.json({ok:true,channel:{is_ext_shared:true}});
    }
    if(String(url).endsWith("chat.postMessage")) {sent.push(JSON.parse(String(options?.body)));return Response.json({ok:true,ts:"1.0"});}
    throw new Error("Unexpected request");
  };
  const allowRetry=()=>{const r=requests.getSetupRequest(id)!;r.retryAt=0;requests.saveSetupRequest(r);};
  try {
    await worker.sweepSetupRequests();
    assert.ok(requests.getSetupRequest(id)!.retryAt! > Date.now()+110_000);
    for(let i=0;i<10;i++) await worker.sweepSetupRequests();
    assert.equal(infoCalls,1);assert.equal(sent.length,0);
    mode="error";allowRetry();await worker.sweepSetupRequests();
    assert.equal(sent.length,1);
    assert.match(sent[0].text,/couldn’t deliver the task update/);
    assert.doesNotMatch(sent[0].text,/conflict|couldn’t apply/);
    assert.equal(requests.getSetupRequest(id)!.notice,"running");
    allowRetry();await worker.sweepSetupRequests();assert.equal(sent.length,1);
    mode="ok";allowRetry();await worker.sweepSetupRequests();
    assert.equal(sent.length,2);assert.equal(sent[1].channel,"DTEST");assert.equal(sent[1].thread_ts,"setup");
    assert.equal(requests.getSetupRequest(id)!.state,"completed");
    const before=infoCalls;
    for(let i=0;i<10;i++) await worker.sweepSetupRequests();
    assert.equal(infoCalls,before);assert.equal(sent.length,2);
  } finally {globalThis.fetch=fetch;}
});

test("unchanged running setup phase does not poll Slack", async () => {
  seedNotificationRequest("unchanged-phase");
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run("resume-unchanged-phase");
  const fetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("Slack unavailable");};
  try {for(let i=0;i<10;i++)await worker.sweepSetupRequests();assert.equal(calls,0);}
  finally {globalThis.fetch=fetch;db.prepare("UPDATE jobs SET status='done' WHERE id=?").run("resume-unchanged-phase");}
});

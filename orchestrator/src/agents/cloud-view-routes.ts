import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { enqueueJob, getJob, cancelCloudJob } from "../opencode.js";
import { cloudMode, conversationRepos, type ConversationRef } from "./cloud-workspaces.js";
import { cloudEvents } from "./cloud-events.js";
import { codingSlotStatus } from "./coding-slot.js";
import { requests } from "./setup-requests.js";
import { isSetupFile } from "./setup-files.js";
import { redactCloudText } from "./repo-env.js";
import { containsSecret } from "../events.js";

function summarize(id: string, includeEvents = true) {
  const job = getJob(id)!;
  const raw = job.result_json ? JSON.parse(job.result_json) : null;
  const result = raw ? { answer_md: redactCloudText(String(raw.answer_md ?? raw.error ?? "")), output: redactCloudText(String(raw.output ?? "")), exit_code: raw.exit_code } : null;
  let message = job.input.display_message ?? (job.input.manual_command ? `Terminal: ${(job.input.manual_command as { command: string }).command}` : job.input.message ?? job.input.question ?? "Task");
  if (!job.input.display_message && typeof message === "string" && message.startsWith("Style:")) message = message.slice(message.lastIndexOf("\n\n") + 2);
  const pendingSetup = requests().some(r => r.job === id && ["requesting", "waiting", "ready"].includes(r.state));
  return { id, status: job.status, phase: pendingSetup ? "setup" : ["running", "queued"].includes(job.status) ? codingSlotStatus(id) ?? job.status : job.status,
    message: redactCloudText(String(message)).slice(0, 8000), created_at: job.created_at, updated_at: job.updated_at,
    repos: conversationRepos(String(job.input.conversation_key)),
    command: Boolean(job.input.manual_command), session_id: job.session_id, result, events: includeEvents ? cloudEvents(id) : [] };
}
export function registerCloudViewRoutes(app: FastifyInstance): void {
  app.get("/v1/agents/tasks", async (_req, reply) => {
    if (!cloudMode()) return reply.code(409).send({ error: "Cloud mode required" });
    const rows = db.prepare(`SELECT max(rowid) AS rowid FROM jobs WHERE json_extract(input, '$.conversation_key') IS NOT NULL GROUP BY json_extract(input, '$.conversation_key') ORDER BY rowid DESC LIMIT 100`).all() as { rowid: number }[];
    const tasks = rows.map(({ rowid }) => {
      const { id } = db.prepare("SELECT id FROM jobs WHERE rowid = ?").get(rowid) as { id: string };
      const { events, ...task } = summarize(id, false);
      return task;
    });
    return { tasks, repos: conversationRepos("cloud-repo-list").map((r) => ({ name: r.name })) };
  });
  app.get<{ Params: { id: string } }>("/v1/agents/tasks/:id", async (req, reply) => {
    const job = getJob(req.params.id);
    const key = job?.input.conversation_key;
    if (!job || !cloudMode() || typeof key !== "string") return reply.code(404).send({ error: "Cloud task not found" });
    const rows = db.prepare("SELECT id FROM jobs WHERE json_extract(input, '$.conversation_key') = ? ORDER BY created_at DESC, rowid DESC LIMIT 30").all(key) as { id: string }[];
    const [source, workspace, ref] = JSON.parse(key) as string[];
    let slackUrl: string | undefined;
    if (source === "slack") {
      try { const [channel, ts] = JSON.parse(ref); if (/^[A-Z0-9]+$/.test(channel) && /^[0-9.]+$/.test(ts)) slackUrl = `https://app.slack.com/client/${encodeURIComponent(workspace)}/${channel}/thread/${channel}-${ts}`; } catch {}
    }
    return { turns: rows.reverse().map((r) => summarize(r.id)), repos: conversationRepos(key), slackUrl };
  });
  app.get<{ Params: { id: string }; Querystring: { repo?: string } }>("/v1/agents/tasks/:id/diff", async (req, reply) => {
    const job = getJob(req.params.id);
    const key = job?.input.conversation_key;
    if (!cloudMode() || typeof key !== "string") return reply.code(404).send({ error: "Cloud task not found" });
    const repo = conversationRepos(key).find(r => r.worktree && (!req.query.repo || r.name === req.query.repo));
    if (!repo?.worktree || repo.worktree.archived_at) return { files: [], diff: "", truncated: false, scope: "base", base: null };
    const { reconcileWorktree } = await import("./cloud-workspaces.js");
    await reconcileWorktree(key, repo);
    const { worktreeDiff } = await import("./runtime.js");
    const result = await worktreeDiff(repo.worktree.path, repo.name);
    if ("error" in result) return reply.code(409).send(result);
    const sensitive = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|credentials|id_rsa|id_ed25519)$|\.(?:pem|key)$/i;
    const files = result.files.filter(f => !sensitive.test(f.path) && !isSetupFile(repo.name, f.path));
    const allowed = new Set(files.map(f => f.path));
    const diff = result.diff.split(/(?=^diff --git )/m).filter(chunk => {
      const name = chunk.split("\n")[0].match(/ b\/(.+)$/)?.[1];
      return name && allowed.has(name);
    }).map(chunk => chunk.split("\n").map(line => redactCloudText(line)).join("\n")).join("");
    return { ...result, files, diff };
  });
  app.post<{ Params: { id: string; action: string }; Body: { message?: string; repo?: string; command?: string } }>("/v1/agents/tasks/:id/:action", async (req, reply) => {
    const job = getJob(req.params.id);
    const key = job?.input.conversation_key;
    if (!job || !cloudMode() || typeof key !== "string") return reply.code(404).send({ error: "Cloud task not found" });
    if (req.params.action === "cancel") return { cancelled: cancelCloudJob(job.id) };
    if (!["followup", "command"].includes(req.params.action)) return reply.code(404).send({ error: "Unknown action" });
    const [source, workspace, id] = JSON.parse(key) as string[];
    const conversation: ConversationRef = { source, workspace, id };
    const body = req.body ?? {};
    const command = req.params.action === "command";
    const text = command ? body.command : body.message;
    if (typeof text !== "string" || !text.trim() || text.length > 16_000 || containsSecret(text) || redactCloudText(text) !== text) return reply.code(400).send({ error: "Provide text without credentials, at most 16000 characters" });
    if (command && !conversationRepos(key).some((r) => r.name === body.repo)) return reply.code(400).send({ error: "Select a registered repository" });
    return reply.code(202).send(await enqueueJob({ type: "answer", input: {
      question: text, display_message: command ? `Terminal: ${text}` : text, conversation,
      ...(command ? { manual_command: { repo: body.repo, command: text } } : {}),
    } }));
  });
}

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { getJob, jobScopedToken, codingChildPid, pauseCloudJobForSetup } from "../opencode.js";
import { cloudMode, conversationRepos, ensureConversationWorktree } from "./cloud-workspaces.js";
import { requestCodingSlot } from "./coding-slot.js";
import { createSetupRequest, getSetupRequest, requests } from "./setup-requests.js";
import { rememberExistingSetup, setupEnvironment, setupFiles } from "./setup-files.js";
import { redactCloudText } from "./repo-env.js";
import { openSetupTerminal, readSetupTerminal, writeSetupTerminal, closeSetupTerminal } from "./setup-terminal.js";

export function registerSetupRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string }; Body: { action: string; repo: string; environment?: string; kind?: "file" | "value" | "terminal"; destination?: string; variable?: string; reason?: string; from?: "source" | "worktree" } }>("/v1/agents/tasks/:id/setup", async (req, reply) => {
    const actual = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
    const expected = Buffer.from(jobScopedToken(req.params.id));
    if (!cloudMode() || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: "Unauthorized" });
    const job = getJob(req.params.id), body = req.body;
    const conversation = job?.input.conversation_key;
    if (!job || job.status !== "running" || typeof conversation !== "string") return reply.code(403).send({ error: "A running cloud task is required" });
    try {
      const repo = conversationRepos(conversation).find(r => r.name === body?.repo);
      if (!repo) throw new Error("Select a registered repository");
      if (body.action === "list") return { files: setupFiles(repo.name).map(({ destination, environment }) => ({ destination, environment })) };
      if (!body.environment || !/^[A-Za-z0-9_-]{1,64}$/.test(body.environment)) throw new Error("Specify the intended environment; ask the requester if unclear");
      if (body.action === "request") {
        const [source, team, ref] = JSON.parse(conversation);
        if (source !== "slack") throw new Error("Setup requests currently need an originating Slack conversation");
        const [channel, thread] = JSON.parse(ref);
        const original = db.prepare("SELECT input FROM jobs WHERE json_extract(input,'$.conversation_key') = ? AND json_extract(input,'$.slack_requester') IS NOT NULL ORDER BY rowid LIMIT 1").get(conversation) as { input: string } | undefined;
        const requester = original ? JSON.parse(original.input).slack_requester : undefined;
        if (!requester) throw new Error("The original Slack requester is unknown; start a new Slack task");
        if (!body.reason?.trim() || body.reason.length > 2000 || redactCloudText(body.reason) !== body.reason) throw new Error("Describe the missing setup without including credentials");
        const request = await createSetupRequest({ job: job.id, conversation, requester, team, channel, thread, repo: repo.name, environment: body.environment, kind: body.kind!, destination: body.destination, variable: body.variable, reason: body.reason });
        // Stop even an agent that ignores the returned handoff instruction.
        setTimeout(() => pauseCloudJobForSetup(job.id, request.id), 100).unref();
        return { waiting: true, request: request.id, instruction: "Stop this turn. Flow has DMed the requester and will resume the original task after setup." };
      }
      if (!["remember", "select"].includes(body.action)) throw new Error("Unknown setup action");
      if (requests().some(r => r.job === job.id && ["requesting", "waiting", "ready"].includes(r.state))) throw new Error("This task is waiting for setup");
      if (!requestCodingSlot(job.id, codingChildPid(job.id)).acquired) return reply.code(423).send({ error: "Waiting for the coding slot" });
      setupEnvironment(conversation, repo.name, body.environment);
      const owned = await ensureConversationWorktree(conversation, repo.name);
      if (body.action === "remember") {
        if (!["source", "worktree"].includes(body.from ?? "")) throw new Error("Choose source or worktree for the existing file");
        rememberExistingSetup({ repo: repo.name, environment: body.environment, destination: body.destination ?? "", source: repo.source, worktree: owned.worktree!.path, conversation, from: body.from! });
      } else await ensureConversationWorktree(conversation, repo.name, true);
      return { configured: true, repo: repo.name, environment: body.environment, destination: body.destination };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error && !("cmd" in error) ? error.message : "Setup operation failed; existing files were retained" }); }
  });
  // These routes use the normal authenticated dashboard/admin middleware, never a job token.
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>("/v1/agents/setup/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const request = getSetupRequest(req.params.id);
    if (!cloudMode() || !request || request.kind !== "terminal") return reply.code(404).send({ error: "Setup terminal not found" });
    return { repo: request.repo, environment: request.environment, reason: request.reason, state: request.state, ...readSetupTerminal(request.id, Number(req.query.cursor) || 0) };
  });
  app.post<{ Params: { id: string }; Body: { action?: string; data?: string; cols?: number; rows?: number } }>("/v1/agents/setup/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!cloudMode()) return reply.code(404).send({ error: "Not found" });
    try {
      const { action, data, cols, rows } = req.body ?? {};
      if (action === "open") return await openSetupTerminal(req.params.id);
      if (action === "input") { writeSetupTerminal(req.params.id, data ?? "", cols, rows); return { ok: true }; }
      if (action === "close" || action === "complete") { closeSetupTerminal(req.params.id, action === "complete"); return { ok: true }; }
      return reply.code(400).send({ error: "Unknown terminal action" });
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
}

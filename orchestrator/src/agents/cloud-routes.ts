import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { containsSecret } from "../events.js";
import { enqueueJob, getJob, jobScopedToken } from "../opencode.js";
import {
  cloudMode, conversationKey, conversationRepos, ensureConversationWorktree, type ConversationRef,
} from "./cloud-workspaces.js";

export function registerCloudTaskRoutes(app: FastifyInstance): void {
  // Adapters translate their thread/run identity into this contract. Replies
  // remain adapter-owned; callers poll the ordinary /v1/jobs/:id result.
  app.post("/v1/agents/tasks", async (req, reply) => {
    if (!cloudMode()) return reply.code(409).send({ error: "Cloud tasks require FLOW_MODE=prod" });
    const body = req.body as { message?: string; conversation?: ConversationRef; backend?: string };
    if (body?.backend && body.backend !== "opencode") {
      return reply.code(400).send({ error: "Cloud coding tasks support only OpenCode" });
    }
    if (typeof body?.message !== "string" || !body.message.trim()) {
      return reply.code(400).send({ error: "message is required" });
    }
    try { conversationKey(body.conversation!); }
    catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
    if (containsSecret(body.message)) return reply.code(400).send({ error: "Message contains credentials" });
    const job = await enqueueJob({ type: "answer", input: { question: body.message, conversation: body.conversation } });
    return reply.code(202).send({ ...job, backend: "opencode" });
  });

  // Exempted from the admin middleware ONLY for this exact POST route. A job
  // credential grants access to that running job's own conversation, nothing else.
  app.post<{ Params: { id: string }; Body: { repo?: string; edit?: boolean } }>(
    "/v1/agents/tasks/:id/workspace", async (req, reply) => {
      if (!cloudMode()) return reply.code(409).send({ error: "Cloud tasks require FLOW_MODE=prod" });
      const actual = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
      const expected = Buffer.from(jobScopedToken(req.params.id));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const job = getJob(req.params.id);
      const key = job?.input.conversation_key;
      if (!job || job.status !== "running" || typeof key !== "string" || !["answer", "continue"].includes(job.type)) {
        return reply.code(403).send({ error: "A running cloud conversation job is required" });
      }
      const { repo, edit } = req.body ?? {};
      if ((repo !== undefined && typeof repo !== "string") || (edit !== undefined && typeof edit !== "boolean") || (edit && !repo)) {
        return reply.code(400).send({ error: "edit requires a registered repo name" });
      }
      try {
        if (edit) await ensureConversationWorktree(key, repo!);
        return { repos: conversationRepos(key) };
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    },
  );
}

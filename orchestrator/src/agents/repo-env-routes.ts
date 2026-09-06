import type { FastifyInstance } from "fastify";
import { cloudMode, conversationRepos } from "./cloud-workspaces.js";
import { listRepoEnv, saveRepoEnv, removeRepoEnv } from "./repo-env.js";

export function registerRepoEnvRoutes(app: FastifyInstance): void {
  app.route<{ Params: { repo: string }; Body: { filename?: string; content?: string } }>({
    method: ["GET", "PUT", "DELETE"], url: "/v1/agents/repos/:repo/env",
    async handler(req, reply) {
      reply.header("Cache-Control", "no-store");
      if (!cloudMode()) return reply.code(409).send({ error: "Repository env uploads are available on cloud workers" });
      const repo = conversationRepos("env-settings").find((r) => r.name === req.params.repo);
      if (!repo) return reply.code(404).send({ error: "Repository not found" });
      try {
        if (req.method !== "GET") {
          const { filename, content } = req.body ?? {};
          if (typeof filename !== "string" || (req.method === "PUT" && typeof content !== "string")) return reply.code(400).send({ error: "filename and text content are required" });
          if (req.method === "PUT") saveRepoEnv(repo.name, filename, content!);
          else removeRepoEnv(repo.name, filename);
        }
        return { files: listRepoEnv(repo.name), applies: "At the start of the next task turn" };
      } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    },
  });
}

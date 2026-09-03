// slack-agent/routes.ts — dashboard-facing endpoints for the Slack bot card.
//
// GET /v1/slack-agent/status   — connection state for the Add/Disconnect card
// GET /v1/slack-agent/manifest — instance-parameterized app manifest + the
//                                api.slack.com deep link that prefills it

import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FLOW_ROOT } from "../agents/runtime.js";
import { slackAgentStatus } from "./boot.js";
import { buildManifest, createAppUrl } from "./manifest.js";

function projectName(): string {
  const projectDir = dirname(process.env.DB_PATH ?? join(FLOW_ROOT, "data", "flow.db"));
  try {
    const pj = JSON.parse(readFileSync(join(projectDir, "project.json"), "utf8")) as { name?: string };
    if (typeof pj.name === "string" && pj.name) return pj.name;
  } catch {
    /* fall through */
  }
  return "flow";
}

export function registerSlackAgentRoutes(app: FastifyInstance): void {
  app.get("/v1/slack-agent/status", async (_req, reply) => {
    return reply.send(slackAgentStatus());
  });

  app.get("/v1/slack-agent/manifest", async (_req, reply) => {
    const name = projectName();
    return reply.send({
      project: name,
      manifest: buildManifest(name),
      create_url: createAppUrl(name),
    });
  });
}

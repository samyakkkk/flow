// index.ts — Boot: HTTP server, middleware, route registration.
// Port 7500 (ORCHESTRATOR_PORT env override).

import Fastify from "fastify";
import { requireAuth } from "./auth.js";
import { registerEventRoutes } from "./events.js";
import { registerOutboxRoutes } from "./outbox-routes.js";
import { registerPolicyRoutes } from "./policy.js";
import { registerCorpusRoutes } from "./corpus.js";
import db from "./db.js";
import { getJob, enqueueJob, recoverStalledJobs, killRunningJobChildren, repoStatuses } from "./opencode.js";
import { activityForRepo } from "./job-activity.js";
import { readIndexLog } from "./index-log.js";
import { registerLinearWebhook, registerLinearPoller } from "./adapters/linear.js";
import { registerGithubWebhook, registerGithubPoller, seedWatchedRepos } from "./adapters/github.js";
import { registerMeetingRoutes, registerFirefliesPoller } from "./adapters/meetings.js";
import { bootSlackAdapter } from "./adapters/slack.js";
import { startDrainer, stopDrainer } from "./drainer.js";
import { registerNotifyRoute } from "./notify.js";
import { registerModeRoute } from "./mode.js";
import { registerLlmLogRoute } from "./llmlog.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { registerIngestRoutes } from "./ingest/routes.js";
import { registerIntegrationRoutes } from "./integrations.js";
import { registerCorrectionRoutes } from "./corrections.js";
import { registerMemoryRoutes } from "./memory/routes.js";
import { setNodeAnchorProvider } from "./memory/anchors.js";
import { makeGatewayAnchorProvider } from "./memory/anchor-provider.js";
import { registerSourceRoutes } from "./sources.js";
import { startAllPollers, stopAllPollers, getAllPollStatus } from "./pollers/engine.js";
import { registerSettingsRoutes } from "./settings.js";

const PORT = parseInt(process.env.ORCHESTRATOR_PORT ?? "7500", 10);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

// ------------------------------------------------------------------
// Raw body parser — required by webhook routes for HMAC validation.
// Registered globally here so Linear + GitHub adapters don't each fight
// to register the same content-type parser.
// ------------------------------------------------------------------
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
  try {
    // Expose both raw (for HMAC) and parsed (for regular routes)
    const parsed = JSON.parse((body as Buffer).toString("utf-8")) as unknown;
    // Attach raw buffer to request so webhook handlers can reach it
    (req as Record<string, unknown>)._rawBody = body as Buffer;
    done(null, parsed);
  } catch (err) {
    done(err as Error, undefined);
  }
});

// ------------------------------------------------------------------
// Auth hook — all routes except GET /health
// ------------------------------------------------------------------
app.addHook("onRequest", (req, reply, done) => requireAuth(req, reply, done));

// ------------------------------------------------------------------
// Health (unauthenticated)
// ------------------------------------------------------------------
app.get("/health", async () => ({
  status: "ok",
  service: "orchestrator",
  port: PORT,
  ts: Date.now(),
}));

// ------------------------------------------------------------------
// Core route groups
// ------------------------------------------------------------------
registerEventRoutes(app);
registerOutboxRoutes(app);
registerPolicyRoutes(app);
registerCorpusRoutes(app);
registerNotifyRoute(app);
registerModeRoute(app);
registerSettingsRoutes(app);
registerLlmLogRoute(app);
registerAgentRoutes(app);
registerIngestRoutes(app);
registerIntegrationRoutes(app);
registerCorrectionRoutes(app);
registerMemoryRoutes(app);
// Memory anchors resolve graph node paths through the gateway; a null gateway
// (no FLOW_GATEWAY_URL) leaves the default no-op provider and items stay
// repo-level. flow.db is primary — this is a read-only projection lookup.
setNodeAnchorProvider(makeGatewayAnchorProvider());
registerSourceRoutes(app);

// ------------------------------------------------------------------
// Adapter webhook routes
// ------------------------------------------------------------------
// Note: linear + github webhook routes use a custom content-type parser
// (raw Buffer) for HMAC validation. We register them only when the webhook
// routes are not already covered by a catch-all parser.
registerLinearWebhook(app);
registerGithubWebhook(app);
registerMeetingRoutes(app);

// ------------------------------------------------------------------
// GET /v1/ingest/status — per-source poll cursor + lag info
// Dashboard "catching up" indicator.
// Response: {sources: [{source, resource, cursor, last_poll_at, lag_seconds, catching_up, status}]}
// See also: src/ingest-status.ts (exported registerIngestStatusRoute for standalone use)
// ------------------------------------------------------------------
app.get("/v1/ingest/status", async (_req, reply) => {
  const rows = getAllPollStatus();
  const now = Math.floor(Date.now() / 1000);
  const sources = rows.map((row) => ({
    source: row.source,
    resource: row.resource,
    cursor: row.cursor,
    last_poll_at: row.last_poll_at,
    lag_seconds: row.last_poll_at > 0 ? now - row.last_poll_at : null,
    catching_up: row.status === "catching_up",
    status: row.status,
  }));
  return reply.send({ sources });
});

// ------------------------------------------------------------------
// Ask endpoint: question → answer job → returns job id + result when done
// ------------------------------------------------------------------
app.post<{ Body: { question: string; wait?: boolean } }>(
  "/v1/ask",
  async (req, reply) => {
    const { question, wait } = req.body as { question?: string; wait?: boolean };

    if (!question || question.trim().length === 0) {
      return reply.code(400).send({ error: "question is required" });
    }

    const { id } = await enqueueJob({ type: "answer", input: { question } });

    if (wait) {
      // Poll until done (capped at 30s for sync path)
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const job = getJob(id);
        if (job?.status === "done" || job?.status === "failed") {
          const result = job.result_json ? JSON.parse(job.result_json) as Record<string, unknown> : {};
          return reply.send({ id, ...result, status: job.status });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return reply.code(202).send({ id, status: "running", message: "Job still running; poll GET /v1/jobs/:id" });
    }

    return reply.code(202).send({ id, status: "queued" });
  }
);

// ------------------------------------------------------------------
// Job status
// ------------------------------------------------------------------
app.get<{ Params: { id: string } }>(
  "/v1/jobs/:id",
  async (req, reply) => {
    const job = getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "Not found" });
    const result = job.result_json ? JSON.parse(job.result_json) as Record<string, unknown> : null;
    return reply.send({ ...job, result });
  }
);

// ------------------------------------------------------------------
// Live indexer activity — what the current/latest index job for a repo is
// doing right now (terse tool-call labels + counts). In-memory and live-only:
// the ticker empties when the job ends; job-logs/ keeps the full transcript.
// ------------------------------------------------------------------
app.get<{ Querystring: { repo?: string } }>(
  "/v1/index-activity",
  async (req, reply) => {
    const repo = req.query.repo ?? "";
    if (!repo) return reply.code(400).send({ error: "repo query param required" });
    const activity = activityForRepo(repo);
    if (!activity) return reply.send({ status: "idle" });
    return reply.send(activity);
  }
);

// ------------------------------------------------------------------
// Repo status — the per-repo state machine (never_indexed | queued |
// indexing | indexed | failed) derived from the registry + jobs table.
// The dashboard's source of truth for "is this repo fresh?".
// ------------------------------------------------------------------
app.get("/v1/repos/status", async (_req, reply) => {
  return reply.send({ repos: repoStatuses() });
});

// ------------------------------------------------------------------
// Indexer event log — the durable lifecycle trail (enqueued, parked,
// superseded, started, done, failed, recovered, watch, removed) so a
// self-deployer can reconstruct what the indexer did and when. Unlike
// /v1/index-activity this survives restarts and job completion.
// ------------------------------------------------------------------
app.get<{ Querystring: { repo?: string; limit?: string } }>(
  "/v1/index-log",
  async (req, reply) => {
    const rows = readIndexLog({
      repo: req.query.repo || undefined,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    });
    return reply.send({ rows, count: rows.length });
  }
);

// ------------------------------------------------------------------
// Audit log
// ------------------------------------------------------------------
app.get<{ Querystring: { limit?: string } }>(
  "/v1/audit",
  async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 500);
    const rows = db.prepare(
      "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?"
    ).all(limit);
    return reply.send({ rows, count: rows.length });
  }
);

// ------------------------------------------------------------------
// Outbox
// ------------------------------------------------------------------
app.get<{ Querystring: { status?: string } }>(
  "/v1/outbox",
  async (req, reply) => {
    const status = req.query.status ?? "pending";
    const rows = db.prepare(
      "SELECT * FROM outbox WHERE status = ? ORDER BY id DESC LIMIT 200"
    ).all(status);
    return reply.send({ rows, count: rows.length });
  }
);

// ------------------------------------------------------------------
// Graceful shutdown hook (registered before listen)
// ------------------------------------------------------------------
app.addHook("onClose", async () => {
  stopDrainer();
  stopAllPollers();
  // Kill live indexer CLIs (and their process groups) — an orphaned indexer
  // surviving a restart would keep writing to the graph while boot recovery
  // re-queues a duplicate job for the same repo.
  const killed = killRunningJobChildren();
  if (killed > 0) console.warn(`[orchestrator] killed ${killed} live job child process(es) on shutdown`);
});

// Without these handlers a SIGTERM (flow down / flow rm / systemd stop)
// hard-kills the process and onClose never runs — leaving indexer CLI
// children orphaned and still writing to the graph.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    void app.close().finally(() => process.exit(0));
  });
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
const start = async (): Promise<void> => {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`[orchestrator] listening on port ${PORT}`);

    // Recover jobs left 'running' by a crash/restart (S103)
    recoverStalledJobs();

    // Start outbox drainer (no-ops if FLOW_DRAIN_DISABLE=1 or already running)
    if (process.env.FLOW_DRAIN_DISABLE !== "1") {
      startDrainer();
    }

    // Register all pollers with the engine (enabled() checks gating at tick time)
    await seedWatchedRepos();
    // Legacy localPath entries become the "local" owner's work folders.
    const { seedWorkFoldersFromRegistry } = await import("./work-folders.js");
    seedWorkFoldersFromRegistry();
    registerGithubPoller();
    registerLinearPoller();
    registerFirefliesPoller();

    // Start all registered pollers (no-ops if FLOW_POLL_DISABLE=1)
    startAllPollers();

    // Boot Slack Socket Mode adapter (no-op if tokens absent)
    bootSlackAdapter().catch((err) =>
      console.error("[orchestrator] Slack adapter boot error:", err)
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

export { app };

// Agents v1 HTTP surface. Everything the dashboard needs:
//   GET  /v1/agents                       installed agents + connected repos
//   GET  /v1/agents/sessions              session list (newest first)
//   POST /v1/agents/sessions              {backend, repo, prompt} → {id}
//   GET  /v1/agents/sessions/:id          metadata + full transcript replay
//   GET  /v1/agents/sessions/:id/events   SSE: replay then live events
//   POST /v1/agents/sessions/:id/prompt   {text} — steer (queues/cancels as needed)
//   POST /v1/agents/sessions/:id/cancel   stop the current turn
//   POST /v1/agents/sessions/:id/permission {requestId, optionId|null}
//   POST /v1/agents/sessions/:id/mode     {modeId}
//   POST /v1/agents/graph-activity        (from the injected MCP subprocess)

import type { FastifyInstance } from "fastify";
import {
  type AgentBackend,
  BACKENDS,
  cancelSession,
  createSession,
  detectAgents,
  getSession,
  listRepoOptions,
  listSessions,
  readTranscript,
  recordGraphActivity,
  slimEvent,
  resolvePermission,
  setConfigOption,
  setSessionMode,
  openLocation,
  steer,
  subscribe,
} from "./runtime.js";

export function registerAgentRoutes(app: FastifyInstance): void {
  app.get("/v1/agents", async () => {
    const agents = await detectAgents();
    return { agents, repos: listRepoOptions() };
  });

  app.get("/v1/agents/sessions", async () => ({ sessions: listSessions() }));

  app.post("/v1/agents/sessions", async (req, reply) => {
    const body = req.body as { backend?: string; repo?: string; prompt?: string };
    const backend = body.backend as AgentBackend;
    if (!backend || !(backend in BACKENDS)) {
      return reply.code(400).send({ error: `backend must be one of ${Object.keys(BACKENDS).join(", ")}` });
    }
    if (!body.repo || !body.prompt?.trim()) {
      return reply.code(400).send({ error: "repo and prompt are required" });
    }
    const result = await createSession({ backend, repo: body.repo, prompt: body.prompt.trim() });
    if ("error" in result) return reply.code(400).send(result);
    return result;
  });

  app.get("/v1/agents/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const live = getSession(id);
    const rows = listSessions().filter((s) => s.id === id);
    if (!live && rows.length === 0) return reply.code(404).send({ error: "unknown session" });
    const meta = rows[0] ?? {};
    return {
      ...meta,
      live: Boolean(live),
      modes: live?.modes ?? null,
      configOptions: live?.configOptions ?? null,
      pendingPermissions: live
        ? [...live.pendingPermissions.values()].map((p) => ({
            requestId: p.requestId,
            toolCall: p.params.toolCall,
            options: p.params.options,
          }))
        : [],
      events: readTranscript(id).map(slimEvent),
    };
  });

  // SSE stream: full replay (or ?since=seq) then live. The dashboard proxies
  // this through a Next route; auth is the standard bearer hook.
  app.get("/v1/agents/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const since = Number((req.query as { since?: string }).since ?? 0);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (ev: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };

    for (const ev of readTranscript(id, since)) send(slimEvent(ev));

    const unsub = subscribe(id, (ev) => send(slimEvent(ev)));
    if (!unsub) {
      send({ kind: "eof", data: { reason: "session not live — replay only" } });
      reply.raw.end();
      return reply;
    }

    const ping = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`);
      } catch {
        /* closing */
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(ping);
      unsub();
    });
    return reply;
  });

  app.post("/v1/agents/sessions/:id/prompt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text?: string };
    if (!text?.trim()) return reply.code(400).send({ error: "text required" });
    const r = await steer(id, text.trim());
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  app.post("/v1/agents/sessions/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await cancelSession(id);
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  app.post("/v1/agents/sessions/:id/permission", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { requestId, optionId } = req.body as { requestId?: string; optionId?: string | null };
    if (!requestId) return reply.code(400).send({ error: "requestId required" });
    const r = resolvePermission(id, requestId, optionId ?? null);
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  app.post("/v1/agents/sessions/:id/mode", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { modeId } = req.body as { modeId?: string };
    if (!modeId) return reply.code(400).send({ error: "modeId required" });
    const r = await setSessionMode(id, modeId);
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  // Set a session config option — most importantly the model selector.
  app.post("/v1/agents/sessions/:id/config", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { configId, value } = req.body as { configId?: string; value?: string | boolean };
    if (!configId || value === undefined) {
      return reply.code(400).send({ error: "configId and value required" });
    }
    const r = await setConfigOption(id, configId, value);
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  // Open the session's repo folder in Finder/Explorer or VS Code (local-mode
  // convenience — the orchestrator is on the user's machine).
  app.post("/v1/agents/sessions/:id/open", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { target } = req.body as { target?: string };
    if (target !== "finder" && target !== "vscode") {
      return reply.code(400).send({ error: "target must be 'finder' or 'vscode'" });
    }
    const r = openLocation(id, target);
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  // Called by the injected flow-graph MCP subprocess (loopback) on every tool
  // call — this is what lights up the brain graph live in the session view.
  app.post("/v1/agents/graph-activity", async (req, reply) => {
    const body = req.body as { session?: string; verb?: string; args?: string; nodeIds?: string[]; ok?: boolean };
    if (!body.session || !body.verb) return reply.code(400).send({ error: "session and verb required" });
    const ok = recordGraphActivity(body as { session: string; verb: string });
    return { ok };
  });
}

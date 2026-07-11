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
//   GET  /v1/agents/sessions/:id/diff     unified git diff of the checkout
//   GET  /v1/agents/sessions/:id/files    {q} — @mention file/folder autocomplete
//   GET  /v1/agents/repos/files           {repo, q} — same, before a session exists
//   GET  /v1/agents/worktrees             the separate copies (optionally ?repo=)
//   GET  /v1/agents/worktrees/diff        {path} — base-scope diff of a copy
//   POST /v1/agents/worktrees/remove      {path, force?} — delete a copy
//   POST /v1/agents/worktrees/pr          {path, targetBranch?} — push branch and open PR flow
//   POST /v1/agents/worktrees/open        {path, target} — open a copy in Finder/VS Code
//   POST /v1/agents/graph-activity        (from the injected MCP subprocess)

import type { FastifyInstance } from "fastify";
import {
  type AgentBackend,
  BACKENDS,
  cancelSession,
  createSession,
  detectAgents,
  getSession,
  listRepoFiles,
  listRepoOptions,
  listSessionFiles,
  sessionDiff,
  listManagedWorktrees,
  repoHasGithubUrl,
  repoBaseBranch,
  removeManagedWorktree,
  applyManagedWorktree,
  pushManagedWorktree,
  openPullRequestForManagedWorktree,
  openWorktreeLocation,
  worktreeDiffAt,
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

  // Create a session. Response is one of:
  //   {id, separateCopy}                     — started (separateCopy=true → runs
  //                                            in an isolated worktree)
  //   {collision:true, active:{id,title,status}}  — the target folder is already
  //                                            in use by a live session; resend
  //                                            with `placement` to resolve. This
  //                                            is a 200, not an error — the UI
  //                                            asks the user which to do.
  //   {error}                                — 400.
  // `placement` (optional): "in_place" starts anyway in the same folder;
  // "separate_copy" branches the checkout into a worktree and runs there.
  app.post("/v1/agents/sessions", async (req, reply) => {
    const body = req.body as { backend?: string; repo?: string; prompt?: string; placement?: string };
    const backend = body.backend as AgentBackend;
    if (!backend || !(backend in BACKENDS)) {
      return reply.code(400).send({ error: `backend must be one of ${Object.keys(BACKENDS).join(", ")}` });
    }
    if (!body.repo || !body.prompt?.trim()) {
      return reply.code(400).send({ error: "repo and prompt are required" });
    }
    const placement = body.placement;
    if (placement !== undefined && placement !== "in_place" && placement !== "separate_copy") {
      return reply.code(400).send({ error: "placement must be 'in_place' or 'separate_copy'" });
    }
    const result = await createSession({ backend, repo: body.repo, prompt: body.prompt.trim(), placement });
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
      // Runs in an isolated "separate copy" (worktree) rather than the user's
      // checkout — the UI shows a muted chip for it. Derived from worktree_id.
      separateCopy: Boolean((meta as { worktree_id?: string }).worktree_id ?? live?.worktreeId),
      // The worktree path, when this session runs on a separate copy — the exit
      // banner targets it directly. null for in-place sessions.
      worktreePath: (meta as { worktree_id?: string }).worktree_id ?? live?.worktreeId ?? null,
      // Whether the copy's repo has a GitHub url — gates the banner's PR action.
      worktreeGithub: repoHasGithubUrl(String((meta as { repo?: string }).repo ?? "")),
      worktreeBase: repoBaseBranch(String((meta as { repo?: string }).repo ?? "")),
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
    const { text, images } = req.body as { text?: string; images?: Array<{ data: string; mimeType: string }> };
    if (!text?.trim()) return reply.code(400).send({ error: "text required" });
    const r = await steer(id, text.trim(), images);
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

  // What the agent changed in its checkout, in one of two scopes:
  //   ?scope=session (default) — everything since the session started
  //   ?scope=base              — the branch vs its registered base branch
  // Works for live and archived sessions. Response: {files, diff, truncated,
  // scope, base} — scope is the one actually used (base degrades to session
  // when the base branch can't be resolved), base is its name or null.
  app.get("/v1/agents/sessions/:id/diff", async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = (req.query as { scope?: string }).scope ?? "session";
    if (scope !== "session" && scope !== "base") {
      return reply.code(400).send({ error: "scope must be 'session' or 'base'" });
    }
    const r = await sessionDiff(id, scope);
    if ("error" in r) return reply.code(404).send(r);
    return r;
  });

  // @mention autocomplete — files/folders in a session's repo checkout.
  app.get("/v1/agents/sessions/:id/files", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { q } = req.query as { q?: string };
    const r = await listSessionFiles(id, q ?? "");
    if ("error" in r) return reply.code(404).send(r);
    return r;
  });

  // Same, for the "start a new session" composer (no session id yet).
  app.get("/v1/agents/repos/files", async (req, reply) => {
    const { repo, q } = req.query as { repo?: string; q?: string };
    if (!repo) return reply.code(400).send({ error: "repo required" });
    const r = await listRepoFiles(repo, q ?? "");
    if ("error" in r) return reply.code(404).send(r);
    return r;
  });

  // ---- Managed "separate copies" (worktrees) — visibility + exits ----

  // List every flow-managed separate copy (optionally ?repo=<name>). Per tree:
  // {repo, path, branch, base, aheadCount, dirty, merged, health, sessions[],
  // github}. The user's own primary checkout is never listed.
  app.get("/v1/agents/worktrees", async (req) => {
    const { repo } = req.query as { repo?: string };
    return { worktrees: await listManagedWorktrees(repo) };
  });

  // Base-scope diff of a session-less copy: working tree vs merge-base(base,
  // HEAD). Same {files, diff, truncated, scope:"base", base} shape as the
  // session diff.
  app.get("/v1/agents/worktrees/diff", async (req, reply) => {
    const { path } = req.query as { path?: string };
    if (!path) return reply.code(400).send({ error: "path required" });
    const r = await worktreeDiffAt(path);
    if ("error" in r) return reply.code(404).send(r);
    return r;
  });

  // Remove a copy. Refuses non-managed paths, a still-live session, and a dirty
  // tree unless {force:true}. {ok} | {error} (400 on refusal).
  app.post("/v1/agents/worktrees/remove", async (req, reply) => {
    const { path, force } = req.body as { path?: string; force?: boolean };
    if (!path) return reply.code(400).send({ error: "path required" });
    const r = await removeManagedWorktree(path, force === true);
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  // Legacy/internal escape hatch: merge a copy's branch back into the user's
  // checkout. The dashboard no longer offers this because PR-first is safer.
  app.post("/v1/agents/worktrees/apply", async (req, reply) => {
    const { path } = req.body as { path?: string };
    if (!path) return reply.code(400).send({ error: "path required" });
    const r = await applyManagedWorktree(path);
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  // Legacy/internal push. The PR action below is the dashboard path because it
  // commits dirty work, checks conflicts, verifies the remote ref, and returns
  // the GitHub PR URL.
  app.post("/v1/agents/worktrees/push", async (req, reply) => {
    const { path } = req.body as { path?: string };
    if (!path) return reply.code(400).send({ error: "path required" });
    const r = await pushManagedWorktree(path);
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  app.post("/v1/agents/worktrees/pr", async (req, reply) => {
    const { path, targetBranch } = req.body as { path?: string; targetBranch?: string };
    if (!path) return reply.code(400).send({ error: "path required" });
    const r = await openPullRequestForManagedWorktree(path, targetBranch);
    if ("error" in r) return reply.code(400).send(r);
    if ("conflict" in r) return reply.code(409).send(r);
    return r;
  });

  app.post("/v1/agents/worktrees/open", async (req, reply) => {
    const { path, target } = req.body as { path?: string; target?: "finder" | "vscode" };
    if (!path) return reply.code(400).send({ error: "path required" });
    if (target !== "finder" && target !== "vscode") return reply.code(400).send({ error: "target must be finder or vscode" });
    const r = openWorktreeLocation(path, target);
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

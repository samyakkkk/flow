// Agents v1 HTTP surface. Everything the dashboard needs:
//   GET  /v1/agents                       installed agents + connected repos
//   GET  /v1/agents/sessions              session list (newest first)
//   GET  /v1/agents/sessions/search       {q, limit?} — semantic session search
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
//   GET  /v1/agents/repos/branches        {repo} — PR target branch selector options
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
  listRepoBranches,
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
  readSessionMetadata,
  readTranscript,
  recordGraphActivity,
  slimEvent,
  resolvePermission,
  setConfigOption,
  setSessionMode,
  openLocation,
  probeAgentOptions,
  steer,
  subscribe,
} from "./runtime.js";
import { searchSessions } from "./session-search.js";

export function registerAgentRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { owner?: string } }>("/v1/agents", async (req) => {
    const agents = await detectAgents();
    const owner = req.query.owner || "local";
    const { listWorkFolders } = await import("../work-folders.js");
    return { agents, repos: listRepoOptions(), workFolders: listWorkFolders(owner) };
  });

  // What a backend offers (model selector, thought/reasoning toggles, modes)
  // BEFORE any task session exists — probed via a scratch ACP session on the
  // shared adapter connection, cached per backend. Powers the kickoff form's
  // model/thinking/mode selectors so nothing is hardcoded in the UI.
  app.get<{ Querystring: { backend?: string } }>("/v1/agents/options", async (req, reply) => {
    const backend = req.query.backend as AgentBackend | undefined;
    if (!backend || !(backend in BACKENDS)) {
      return reply.code(400).send({ error: `backend must be one of ${Object.keys(BACKENDS).join(", ")}` });
    }
    const result = await probeAgentOptions(backend);
    if ("error" in result) return reply.code(502).send(result);
    return result;
  });

  // Per-user work folders — where THIS user's agent sessions run. Owner is
  // supplied by the dashboard from its session identity ("local" in local
  // mode); folders are never shared across owners.
  app.get<{ Querystring: { owner?: string } }>("/v1/work-folders", async (req) => {
    const { listWorkFolders } = await import("../work-folders.js");
    return { folders: listWorkFolders(req.query.owner || "local") };
  });

  app.post("/v1/work-folders", async (req, reply) => {
    const body = req.body as { owner?: string; path?: string; repo?: string };
    const path = body.path?.trim();
    if (!path) return reply.code(400).send({ error: "path is required" });
    const { addWorkFolder, listWorkFolders } = await import("../work-folders.js");
    addWorkFolder(body.owner?.trim() || "local", path, body.repo?.trim() || undefined);
    return { folders: listWorkFolders(body.owner?.trim() || "local") };
  });

  app.delete("/v1/work-folders", async (req, reply) => {
    const body = req.body as { owner?: string; path?: string };
    if (!body.path) return reply.code(400).send({ error: "path is required" });
    const { removeWorkFolder, listWorkFolders } = await import("../work-folders.js");
    removeWorkFolder(body.owner?.trim() || "local", body.path);
    return { folders: listWorkFolders(body.owner?.trim() || "local") };
  });

  app.get("/v1/agents/sessions", async () => ({ sessions: listSessions() }));

  // Semantic session search: cosine over per-session embeddings (gateway's
  // local model) + lexical boost. `semantic:false` in the response means the
  // query couldn't be embedded (model loading / gateway down) and results are
  // lexical-only. Registered before /:id so "search" never binds as an id.
  app.get("/v1/agents/sessions/search", async (req, reply) => {
    const { q, limit } = req.query as { q?: string; limit?: string };
    const query = q?.trim();
    if (!query) return reply.code(400).send({ error: "q required" });
    const lim = Math.max(1, Math.min(50, Number(limit) || 20));
    return await searchSessions(query, lim);
  });

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
  // `worktreePath` (optional): run in an EXISTING managed copy — the "+ new
  // session" action on a copy card. No collision prompt; targeting is deliberate.
  app.post("/v1/agents/sessions", async (req, reply) => {
    const body = req.body as {
      backend?: string;
      repo?: string;
      prompt?: string;
      placement?: string;
      workFolder?: string;
      worktreePath?: string;
      owner?: string;
      config?: Record<string, string | boolean>;
      modeId?: string;
      attachments?: Array<{ name?: string; data: string; mimeType: string }>;
      images?: Array<{ data: string; mimeType: string }>;
    };
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
    // A work folder must be one the requesting owner registered — sessions
    // never run in a path some other user (or nobody) vouched for.
    let workFolder: string | undefined;
    if (body.workFolder?.trim()) {
      const { listWorkFolders } = await import("../work-folders.js");
      const owned = listWorkFolders(body.owner?.trim() || "local").some((f) => f.path === body.workFolder);
      if (!owned) return reply.code(400).send({ error: "workFolder is not registered for this user" });
      workFolder = body.workFolder.trim();
    }
    // Kickoff-chosen config (model/thought selectors, mode): only values the
    // client explicitly changed, validated to the advertised primitive types.
    let config: Record<string, string | boolean> | undefined;
    if (body.config && typeof body.config === "object" && !Array.isArray(body.config)) {
      config = {};
      for (const [k, v] of Object.entries(body.config)) {
        if (typeof v === "string" || typeof v === "boolean") config[k] = v;
      }
      if (Object.keys(config).length === 0) config = undefined;
    }
    const modeId = typeof body.modeId === "string" && body.modeId.trim() ? body.modeId.trim() : undefined;
    // First-turn attachments — same shape + semantics as the steer endpoint.
    const rawAttachments: Array<{ name?: string; data: string; mimeType: string }> =
      body.attachments ?? body.images ?? [];
    const attachments = rawAttachments.map((a, i) => ({
      name: a.name ?? `attachment-${i + 1}`,
      data: a.data,
      mimeType: a.mimeType,
    }));
    const worktreePath =
      typeof body.worktreePath === "string" && body.worktreePath.trim() ? body.worktreePath.trim() : undefined;
    const result = await createSession({
      backend,
      repo: body.repo,
      prompt: body.prompt.trim(),
      placement,
      workFolder,
      worktreePath,
      config,
      modeId,
      attachments: attachments.length ? attachments : undefined,
    });
    if ("error" in result) return reply.code(400).send(result);
    return result;
  });

  app.get("/v1/agents/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const live = getSession(id);
    const row = readSessionMetadata(id);
    if (!live && !row) return reply.code(404).send({ error: "unknown session" });
    const meta = row ?? {};
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
    const body = req.body as {
      text?: string;
      attachments?: Array<{ name?: string; data: string; mimeType: string }>;
      images?: Array<{ data: string; mimeType: string }>; // back-compat: image-only clients
    };
    if (!body.text?.trim()) return reply.code(400).send({ error: "text required" });
    const attachments = (body.attachments ?? body.images ?? []).map((a, i) => ({
      name: (a as { name?: string }).name?.trim() || `attachment-${i + 1}`,
      data: a.data,
      mimeType: a.mimeType,
    }));
    const r = await steer(id, body.text.trim(), attachments.length ? attachments : undefined);
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
  // `folder` narrows the listing to a work folder the requesting owner
  // registered — same vouching rule as session creation.
  app.get("/v1/agents/repos/files", async (req, reply) => {
    const { repo, q, folder, owner } = req.query as { repo?: string; q?: string; folder?: string; owner?: string };
    if (!repo) return reply.code(400).send({ error: "repo required" });
    let dir: string | undefined;
    if (folder?.trim()) {
      const { listWorkFolders } = await import("../work-folders.js");
      const wanted = folder.trim();
      if (!listWorkFolders(owner?.trim() || "local").some((f) => f.path === wanted)) {
        return reply.code(400).send({ error: "folder is not registered for this user" });
      }
      dir = wanted;
    }
    const r = await listRepoFiles(repo, q ?? "", 40, dir);
    if ("error" in r) return reply.code(404).send(r);
    return r;
  });

  app.get("/v1/agents/repos/branches", async (req, reply) => {
    const { repo } = req.query as { repo?: string };
    if (!repo) return reply.code(400).send({ error: "repo required" });
    const r = await listRepoBranches(repo);
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

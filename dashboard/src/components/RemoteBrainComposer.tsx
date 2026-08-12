"use client";
// The C2 composer: a page served BY a deployment (e.g. flow.acme.com / an EC2
// box) lets you run an agent ON YOUR MACHINE that uses THIS deployment's brain.
// You are already "in" the deployment's project by being on this page — so the
// brain is fixed to it; you only pick a local WORKSPACE (a folder on your
// machine) to run in.
//
// The RUNNER: `flow connect` stands up ONE gateway-less local orchestrator (a
// project of kind "runner", no brain of its own) that runs coding agents for
// ANY connected cloud. We discover it through the door (/api/execution-runner)
// — never borrow an unrelated local project. The flow:
//   1. mint this deployment's brain token   (same-origin POST /api/tokens)
//   2. create a session on the runner        (cross-origin, through the door)
//      with brain = { mcpUrl: <this-origin>/<project>/mcp, token }
// The runner runs the chosen CLI in the folder and mounts the remote brain over
// MCP (orchestrator runtime.ts flowGraphMcp). See decision_flow_execution_door_local_only.
import { useState, useEffect, useCallback } from "react";
import { useProject } from "@/lib/useProject";
import { localFetch, type LocalLink } from "@/lib/executionClient";

interface WorkFolder {
  path: string;
  repo: string | null;
}
interface DetectedAgent {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  installHint?: string;
}

const field: React.CSSProperties = {
  width: "100%",
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "7px 9px",
  color: "var(--text-primary)",
};

const btn: React.CSSProperties = {
  background: "var(--text-primary)",
  color: "var(--surface-1)",
  border: "none",
  borderRadius: 6,
  padding: "7px 14px",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

const chip = (on: boolean): React.CSSProperties => ({
  border: `1px solid ${on ? "var(--text-primary)" : "var(--border)"}`,
  background: on ? "var(--text-primary)" : "transparent",
  color: on ? "var(--surface-1)" : "var(--text-secondary)",
  borderRadius: 6,
  padding: "3px 9px",
  fontSize: 11.5,
  cursor: "pointer",
});

export function RemoteBrainComposer({ link }: { link: LocalLink }) {
  const { project } = useProject(); // this deployment's project — the brain
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const mcpUrl = project ? `${origin}/${project}/mcp` : "";

  // This machine's runner (set up by `flow connect`) — the local orchestrator
  // that hosts the session. Discovered through the door; never surfaced or
  // borrowed from an unrelated project.
  const [runner, setRunner] = useState<string | null>(null);
  const [runnerLoaded, setRunnerLoaded] = useState(false);
  const [workFolders, setWorkFolders] = useState<WorkFolder[]>([]);
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [workFolder, setWorkFolder] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [backend, setBackend] = useState("");
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [sessionUrl, setSessionUrl] = useState("");

  // 1) Find this machine's runner through the door.
  useEffect(() => {
    let cancelled = false;
    localFetch(link, "/api/execution-runner")
      .then((r) => (r.ok ? r.json() : { project: null }))
      .then((d: { project?: string | null }) => {
        if (cancelled) return;
        setRunner(d.project ?? null);
        setRunnerLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setRunnerLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [link]);

  // 2) Pull this machine's registered workspaces + installed CLIs from the runner.
  useEffect(() => {
    if (!runner) return;
    let cancelled = false;
    localFetch(link, `/${runner}/api/agents`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { agents?: DetectedAgent[]; workFolders?: WorkFolder[] }) => {
        if (cancelled) return;
        const wf = d.workFolders ?? [];
        setWorkFolders(wf);
        setWorkFolder((prev) => prev || wf[0]?.path || "");
        const ag = d.agents ?? [];
        setAgents(ag);
        setBackend((prev) => prev || ag.find((a) => a.installed)?.id || "");
      })
      .catch(() => {
        /* leave empty; the folder field still lets them type a path */
      });
    return () => {
      cancelled = true;
    };
  }, [link, runner]);

  const run = useCallback(async () => {
    setError("");
    setSessionUrl("");
    if (!runner) return setError("This machine isn’t set up to run agents yet.");
    const folder = customPath.trim() || workFolder;
    if (!folder) return setError("Pick or enter a workspace folder on your machine.");
    if (!prompt.trim()) return setError("Describe the task to run.");
    if (!backend) return setError("No coding CLI detected on your machine.");
    if (!mcpUrl) return setError("Could not resolve this deployment's brain URL.");
    setStarting(true);
    try {
      const known = workFolders.find((f) => f.path === folder);
      const repo = known?.repo || (folder.split("/").filter(Boolean).pop() || "workspace");

      // 1) Register the folder as a work surface on the runner (idempotent). The
      //    session API only runs in folders registered for this user, so this is
      //    what lets a freshly-typed absolute path Just Work. Only pass a repo
      //    hint when the folder actually maps to a known source.
      const reg = await localFetch(link, `/${runner}/api/work-folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folder, repo: known?.repo || undefined }),
      });
      if (!reg.ok) {
        const e = await reg.json().catch(() => ({}));
        throw new Error(e?.error ?? `Could not register the workspace folder (${reg.status}).`);
      }

      // 2) Mint THIS deployment's brain token (same-origin, prod-only route).
      const tk = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: `local-exec · ${folder.split("/").filter(Boolean).pop() ?? folder}` }),
      }).then((r) => r.json());
      if (!tk?.token) throw new Error(tk?.error ?? "Could not mint a brain token.");

      // 3) Create the session on the runner (through the door), bound to the
      //    remote brain. The runner runs the CLI in `folder` on this machine.
      const res = await localFetch(link, `/${runner}/api/agents/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend,
          workFolder: folder,
          repo,
          prompt: prompt.trim(),
          brain: { mcpUrl, token: tk.token },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      if (data.id) {
        setSessionUrl(`${link.base}/${runner}/agents/${data.id}`);
        setPrompt("");
      } else {
        throw new Error("Session did not start.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }, [runner, customPath, workFolder, prompt, backend, mcpUrl, workFolders, link]);

  const installed = agents.filter((a) => a.installed);

  // Connected, but this machine has no runner — an older CLI that predates the
  // runner, or a connect that didn't finish. Tell them exactly how to fix it.
  if (runnerLoaded && !runner) {
    return (
      <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.6 }}>
        This machine is connected but isn’t set up to run agents yet. Re-run the connect command for this
        deployment — it stands up a local runner:
        <div style={{ ...field, marginTop: 8, whiteSpace: "nowrap", overflowX: "auto" }}>flow connect {origin}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        Run an agent on <strong>this machine</strong> — it uses{" "}
        <strong>this project&apos;s brain{project ? ` (${project})` : ""}</strong>. Pick a workspace on
        your machine; your own CLIs do the work.
      </div>

      {/* Workspace */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)", minWidth: 66 }}>Workspace</span>
        {workFolders.length > 0 && (
          <select
            value={customPath ? "" : workFolder}
            onChange={(e) => {
              setCustomPath("");
              setWorkFolder(e.target.value);
            }}
            style={{ ...field, width: "auto", flex: 1, minWidth: 180 }}
          >
            {workFolders.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
              </option>
            ))}
          </select>
        )}
        <input
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
          placeholder={workFolders.length ? "…or type another absolute path" : "/absolute/path/to/repo"}
          style={{ ...field, flex: 1, minWidth: 180 }}
        />
      </div>

      {/* Agent CLI */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)", minWidth: 66 }}>CLI</span>
        {installed.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-secondary)", fontStyle: "italic" }}>
            No coding CLI detected on this machine.
          </span>
        ) : (
          installed.map((a) => (
            <button key={a.id} type="button" onClick={() => setBackend(a.id)} style={chip(backend === a.id)}>
              {a.name.split(" ")[0]}
            </button>
          ))
        )}
      </div>

      {/* Task */}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the task to run in that workspace…"
        rows={3}
        style={{ ...field, resize: "vertical", lineHeight: 1.5 }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" onClick={run} disabled={starting} style={{ ...btn, opacity: starting ? 0.6 : 1 }}>
          {starting ? "Starting on your machine…" : "Run on my machine"}
        </button>
        {mcpUrl && (
          <span style={{ fontSize: 10.5, color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>
            brain → {mcpUrl.replace(/^https?:\/\//, "")}
          </span>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: "var(--warning, #ff9f0a)" }}>{error}</div>}
      {sessionUrl && (
        <div style={{ fontSize: 12.5 }}>
          ✅ Running on your machine —{" "}
          <a href={sessionUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
            open the session ↗
          </a>
        </div>
      )}
    </div>
  );
}

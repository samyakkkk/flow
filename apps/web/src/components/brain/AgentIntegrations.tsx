import { useEffect, useRef, useState } from "react";
import type {
  BrainAgentIntegration,
  BrainAgentIntegrations,
  BrainCommand,
  BrainHarness,
  BrainResponse,
  ProjectId,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  Gemini,
  GithubCopilotIcon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";

const icons = {
  claude: ClaudeAI,
  codex: OpenAI,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
  gemini: Gemini,
  copilot: GithubCopilotIcon,
  antigravity: AntigravityIcon,
};

const harnesses: ReadonlyArray<{ id: BrainHarness; name: string }> = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
  { id: "opencode", name: "OpenCode" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "copilot", name: "GitHub Copilot" },
  { id: "antigravity", name: "Antigravity" },
];

export function CodingToolIcons({ tools }: { tools: readonly BrainHarness[] }) {
  return (
    <span className="inline-flex items-center gap-2" aria-label="Configured coding tools">
      {harnesses
        .filter((tool) => tools.includes(tool.id))
        .map((tool) => {
          const Icon = icons[tool.id];
          return (
            <span
              key={tool.id}
              title={`Flow Brain configured in ${tool.name}`}
              aria-label={`Flow Brain configured in ${tool.name}`}
            >
              <Icon className="size-4" aria-hidden />
            </span>
          );
        })}
    </span>
  );
}

export function AllAgentIntegrations({
  projects,
  send,
  refreshKey,
  onChange,
}: {
  projects: ReadonlyArray<{ id: ProjectId; title: string }>;
  send: (command: BrainCommand) => Promise<BrainResponse | null>;
  refreshKey: string;
  onChange: (status: BrainAgentIntegrations | null) => void;
}) {
  const [status, setStatus] = useState<BrainAgentIntegrations | null>(null);
  const [selected, setSelected] = useState<BrainHarness[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    const current = ++revision.current;
    setStatus(null);
    onChange(null);
    setPending(true);
    setError(null);
    void send({ action: "agentIntegrations", operation: "status" })
      .then((response) => {
        if (revision.current !== current) return;
        if (!response?.agentIntegrations || response.error)
          throw Error(response?.error ?? "Could not load coding tools.");
        setStatus(response.agentIntegrations);
        setSelected([...response.agentIntegrations.harnesses]);
        onChange(response.agentIntegrations);
      })
      .catch((cause: unknown) => {
        if (revision.current === current)
          setError(cause instanceof Error ? cause.message : "Could not load coding tools.");
      })
      .finally(() => {
        if (revision.current === current) setPending(false);
      });
    return () => {
      revision.current++;
    };
  }, [send, refreshKey, onChange]);
  const save = async () => {
    const current = revision.current;
    setPending(true);
    setError(null);
    try {
      const response = await send({
        action: "agentIntegrations",
        operation: "configure",
        harnesses: selected,
      });
      if (revision.current !== current) return;
      if (!response?.agentIntegrations || response.error)
        throw Error(response?.error ?? "Could not update coding tools.");
      setStatus(response.agentIntegrations);
      onChange(response.agentIntegrations);
    } catch (cause) {
      if (revision.current === current)
        setError(cause instanceof Error ? cause.message : "Could not update coding tools.");
    } finally {
      if (revision.current === current) setPending(false);
    }
  };
  const connected = status?.projects.filter((project) => project.workspaceId) ?? [];
  const installed = connected.filter(
    (project) =>
      !project.error &&
      project.integration?.workspaceId === project.workspaceId &&
      status?.harnesses.every((tool) => project.integration?.harnesses.includes(tool)),
  );
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-medium">Flow Brain in your coding tools</h3>
        {status && (
          <CodingToolIcons
            tools={status.harnesses.filter(
              (tool) =>
                connected.length > 0 &&
                connected.every(
                  (project) => !project.error && project.integration?.harnesses.includes(tool),
                ),
            )}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {!status
          ? "Checking coding tools…"
          : !status.harnesses.length
            ? "External coding tool support is off."
            : connected.length && installed.length === connected.length
              ? `Configured in ${harnesses
                  .filter((tool) => status.harnesses.includes(tool.id))
                  .map((tool) => tool.name)
                  .join(", ")} for all ${connected.length} connected projects.`
              : `${installed.length} of ${connected.length} connected projects configured. Enable tools below to apply them to all projects.`}
      </p>
      <details>
        <summary className="cursor-pointer text-xs font-medium text-primary">
          Manage coding tools for all projects
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Applies to existing and future projects on this Flow environment. Each project uses its
            assigned Brain. Keep Flow running to use it from your terminal or editor.
          </p>
          <fieldset disabled={pending || !status} className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Coding tools for all projects</legend>
            {harnesses.map((tool) => {
              const Icon = icons[tool.id];
              return (
                <label
                  key={tool.id}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(tool.id)}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, tool.id]
                          : previous.filter((id) => id !== tool.id),
                      )
                    }
                  />
                  <Icon className="size-4" aria-hidden />
                  {tool.name}
                  {status?.detected.includes(tool.id) && (
                    <span className="ml-auto text-xs text-muted-foreground">Detected</span>
                  )}
                </label>
              );
            })}
          </fieldset>
          <Button size="sm" disabled={pending || !status} onClick={() => void save()}>
            {pending
              ? "Updating…"
              : selected.length
                ? "Enable for all projects"
                : "Disable for all projects"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Restart your coding tools after setup and accept their connection prompts. Flow chat
            uses the same Brain automatically.
          </p>
        </div>
      </details>
      {status?.projects
        .filter((project) => project.error)
        .map((project) => (
          <p key={project.projectId} role="alert" className="text-xs text-destructive">
            {projects.find((entry) => entry.id === project.projectId)?.title ?? "Project"}:{" "}
            {project.error}
          </p>
        ))}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function AgentIntegrations({
  projects,
  send,
}: {
  projects: ReadonlyArray<{ id: ProjectId; title: string; workspaceRoot: string }>;
  send: (command: BrainCommand) => Promise<BrainResponse | null>;
}) {
  const [projectId, setProjectId] = useState<ProjectId | undefined>(projects[0]?.id);
  const [status, setStatus] = useState<BrainAgentIntegration | null>(null);
  const [selected, setSelected] = useState<BrainHarness[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    const current = ++revision.current;
    setStatus(null);
    setError(null);
    if (!projectId) return;
    setPending(true);
    void send({ action: "agentIntegration", projectId, operation: "status" })
      .then((response) => {
        if (revision.current !== current) return;
        setPending(false);
        setError(response?.error ?? (response ? null : "Could not load integrations."));
        if (response?.agentIntegration) {
          setStatus(response.agentIntegration);
          setSelected([...response.agentIntegration.harnesses]);
        }
      })
      .catch((cause: unknown) => {
        if (revision.current !== current) return;
        setPending(false);
        setError(cause instanceof Error ? cause.message : "Could not load integrations.");
      });
    return () => {
      revision.current++;
    };
  }, [projectId, send]);
  const manage = async (operation: "configure" | "remove" | "retry") => {
    if (!projectId) return;
    const current = revision.current;
    setPending(true);
    setError(null);
    try {
      const response = await send({
        action: "agentIntegration",
        projectId,
        operation,
        ...(operation === "configure" ? { harnesses: selected } : {}),
      });
      if (revision.current !== current) return;
      setError(response?.error ?? (response ? null : "Could not update integrations."));
      if (response?.agentIntegration) {
        setStatus(response.agentIntegration);
        setSelected([...response.agentIntegration.harnesses]);
      }
    } catch (cause) {
      if (revision.current === current)
        setError(cause instanceof Error ? cause.message : "Could not update integrations.");
    } finally {
      if (revision.current === current) setPending(false);
    }
  };
  return (
    <div className="w-full space-y-3">
      <p className="text-xs text-muted-foreground" role="status">
        Flow chat
        {status?.configured
          ? ` · ${harnesses
              .filter((h) => status.harnesses.includes(h.id))
              .map((h) => h.name)
              .join(" · ")}`
          : " · No external tools configured"}
      </p>
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-primary">
          Manage coding tools
        </summary>
        <div className="mt-3 space-y-3 rounded-lg bg-muted/40 p-3">
          {projects.length > 1 && (
            <select
              aria-label="Integration project"
              value={projectId}
              disabled={pending}
              onChange={(event) =>
                setProjectId(projects.find((p) => p.id === event.target.value)?.id)
              }
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          )}
          <p className="text-xs text-muted-foreground">
            Use this project’s Brain in your terminal or editor. Flow must keep running.
          </p>
          <fieldset disabled={pending} className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Coding tools</legend>
            {harnesses.map((h) => (
              <label
                key={h.id}
                className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(h.id)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, h.id]
                        : previous.filter((id) => id !== h.id),
                    )
                  }
                />
                {h.name}
                <span className="ml-auto text-xs text-muted-foreground">
                  {status?.detected.includes(h.id) ? "Installed" : ""}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending || !selected.length}
              onClick={() => void manage("configure")}
            >
              {pending ? "Updating…" : "Save tools"}
            </Button>
            {status?.configured && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void manage("remove")}
              >
                Disconnect tools
              </Button>
            )}
            {!!status?.pendingCaptures && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void manage("retry")}
              >
                Retry pending activity ({status.pendingCaptures})
              </Button>
            )}
          </div>
          {status?.configured && (
            <p className="text-xs text-muted-foreground">
              Configured for {status.brainName}. Restart your tools and accept their connection
              prompts. Configuration does not yet confirm a conversation was captured.
            </p>
          )}
        </div>
      </details>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

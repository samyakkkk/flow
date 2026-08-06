"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/useProject";
import { useMode } from "@/lib/useMode";
import { LocalExecutionCard } from "@/components/LocalExecutionCard";
import { Button } from "@/components/ui";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";
import { MentionTextarea, type FileEntry } from "@/components/MentionTextarea";
import { FolderPickerDialog } from "@/components/FolderPickerDialog";
import { AgentConfigControls } from "@/components/AgentConfigControls";
import {
  normalizeConfigOptions,
  type AgentModes,
  type ConfigOption,
} from "@/lib/acpConfig";

export interface Attachment {
  name: string;
  mimeType: string;
  data: string; // base64
  previewUrl?: string;
  size?: number;
}

interface DetectedAgent {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  installHint?: string;
}

interface RepoOption {
  name: string;
  cloned: boolean;
  surface?: "folder" | "managed";
  path?: string;
}

interface WorkFolder {
  path: string;
  repo: string | null;
}

// "+ New session" on a copy card targets the composer at that existing copy —
// the session runs inside it instead of a work folder.
export interface CopyTarget {
  path: string;
  branch: string | null;
  repo: string;
}

interface AgentTaskComposerProps {
  nodeCount?: number;
  selectedNodeTag?: string | null;
  onClearNodeTag?: () => void;
  compact?: boolean;
  className?: string;
  worktreeTarget?: CopyTarget | null;
  onClearWorktreeTarget?: () => void;
}

const AGENT_BRANDS: Record<string, BrandName> = {
  claude: "anthropic",
  codex: "openai",
  opencode: "opencode",
};

function formatBytes(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AgentTaskComposer({
  selectedNodeTag,
  onClearNodeTag,
  compact = false,
  className = "",
  worktreeTarget = null,
  onClearWorktreeTarget,
}: AgentTaskComposerProps) {
  const router = useRouter();
  const { prefix } = useProject();
  const { mode } = useMode();

  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [workFolders, setWorkFolders] = useState<WorkFolder[]>([]);

  // Selected engine + its ACP-advertised options (models, thought toggles,
  // modes) — probed live by the orchestrator, never hardcoded here.
  const [backend, setBackend] = useState("");
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
  const [modes, setModes] = useState<AgentModes | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  // Only values the user explicitly changed from the agent defaults — sent at
  // session create and applied before the first turn.
  const [config, setConfig] = useState<Record<string, string | boolean>>({});
  const [configValues, setConfigValues] = useState<Record<string, string | boolean>>({});
  const [modeId, setModeId] = useState<string | undefined>(undefined);
  const [modeChanged, setModeChanged] = useState(false);

  // Local folder target
  const [workFolder, setWorkFolder] = useState("");
  const [repo, setRepo] = useState("");
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);

  // Prompt & Attachments
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  // Set when the target folder is already held by a live (or idle-but-
  // steerable) session — the create call comes back {collision} instead of
  // starting. The user chooses: separate copy, or share the folder anyway.
  const [collision, setCollision] = useState<{ id: string; title: string; status: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Append node tag if clicked in graph
  useEffect(() => {
    if (selectedNodeTag) {
      const tag = `@${selectedNodeTag}`;
      if (!prompt.includes(tag)) {
        setPrompt((prev) => (prev ? `${prev} ${tag}` : tag));
      }
      if (onClearNodeTag) onClearNodeTag();
    }
  }, [selectedNodeTag, prompt, onClearNodeTag]);

  // Load available agents, repos, and registered work folders
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(prefix("/api/agents"));
      if (!res.ok) return;
      const data = await res.json();
      const detected = data.agents ?? [];
      setAgents(detected);

      const allRepos: RepoOption[] = data.repos ?? [];
      setRepos(allRepos);

      const folders: WorkFolder[] = data.workFolders ?? [];
      setWorkFolders(folders);

      const defaultBackend = detected.find((x: DetectedAgent) => x.installed)?.id || "";
      setBackend((prev) => prev || defaultBackend);

      if (!workFolder) {
        if (folders.length > 0) {
          setWorkFolder(folders[0].path);
          setRepo(folders[0].repo || allRepos[0]?.name || "default");
        } else {
          const folderRepo = allRepos.find((r) => r.surface === "folder");
          if (folderRepo) {
            setWorkFolder(folderRepo.path || "");
            setRepo(folderRepo.name);
          } else if (allRepos.length > 0) {
            setRepo(allRepos[0].name);
          }
        }
      }
    } catch {
      // swallow
    }
  }, [prefix, workFolder]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Probe the selected backend's advertised options (model selector, thought
  // toggles, modes) via a scratch ACP session in the orchestrator.
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    setOptionsLoading(true);
    setConfigOptions([]);
    setModes(null);
    setConfig({});
    setConfigValues({});
    setModeId(undefined);
    setModeChanged(false);
    fetch(prefix(`/api/agents/options?backend=${encodeURIComponent(backend)}`))
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { configOptions?: unknown; modes?: unknown }) => {
        if (cancelled) return;
        const opts = normalizeConfigOptions(d.configOptions);
        setConfigOptions(opts);
        const m = (d.modes ?? null) as AgentModes | null;
        setModes(m);
        // Seed display values from the agent's advertised current values.
        const seed: Record<string, string | boolean> = {};
        for (const o of opts) {
          if (o.currentValue !== undefined) seed[o.id] = o.currentValue;
        }
        setConfigValues(seed);
        setModeId(m?.currentModeId);
      })
      .catch(() => {
        /* leave controls empty — the session page still shows them live */
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [backend, prefix]);

  const handleConfigChange = useCallback((configId: string, value: string | boolean) => {
    setConfigValues((v) => ({ ...v, [configId]: value }));
    setConfig((c) => ({ ...c, [configId]: value }));
  }, []);

  const handleModeChange = useCallback((id: string) => {
    setModeId(id);
    setModeChanged(true);
  }, []);

  // Handle local folder selection from FolderPickerDialog
  const handleSelectFolder = async (path: string) => {
    setIsFolderPickerOpen(false);
    setError("");
    try {
      const res = await fetch(prefix("/api/work-folders"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, repo: repo || undefined }),
      });
      const data = await res.json();
      if (res.ok && data.folders) {
        setWorkFolders(data.folders);
      }
      setWorkFolder(path);
    } catch {
      setWorkFolder(path);
    }
  };

  // Autocomplete files from repo/folder — inside a copy target, complete
  // against the copy's own checkout.
  const fetchFiles = useCallback(
    (q: string) => {
      const effRepo = worktreeTarget?.repo ?? repo;
      if (!effRepo) return Promise.resolve([]);
      const folder = worktreeTarget?.path ?? workFolder;
      const folderParam = folder ? `&folder=${encodeURIComponent(folder)}` : "";
      return fetch(
        prefix(`/api/agents/repos/files?repo=${encodeURIComponent(effRepo)}&q=${encodeURIComponent(q)}${folderParam}`)
      )
        .then((r) => (r.ok ? r.json() : { entries: [] }))
        .then((d: { entries?: FileEntry[] }) => d.entries ?? []);
    },
    [repo, workFolder, worktreeTarget, prefix]
  );

  // Handle image / file attachments
  const processFiles = async (files: File[]) => {
    const newAtts: Attachment[] = [];
    for (const file of files) {
      if (file.size > 15 * 1024 * 1024) {
        setError(`File ${file.name} is too large (> 15MB)`);
        continue;
      }
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const isImg = file.type.startsWith("image/");
        newAtts.push({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          data: base64,
          previewUrl: isImg ? URL.createObjectURL(file) : undefined,
          size: file.size,
        });
      } catch {
        // ignore
      }
    }
    if (newAtts.length > 0) {
      setAttachments((prev) => [...prev, ...newAtts]);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const files = items
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) {
      e.preventDefault();
      await processFiles(files);
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      await processFiles(files);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  // Launch Agent Task. `placement` is set only after the user answers a
  // collision prompt: "separate_copy" runs on an isolated copy, "in_place"
  // shares the folder with the live session.
  const handleStartTask = async (e?: React.FormEvent, placement?: "in_place" | "separate_copy") => {
    e?.preventDefault();
    if (!prompt.trim() || starting) return;

    if (!workFolder && !worktreeTarget) {
      setError("Please choose a local folder to run the agent task in.");
      setIsFolderPickerOpen(true);
      return;
    }

    setStarting(true);
    setError("");
    setCollision(null);

    try {
      // A copy target runs the session inside that existing separate copy —
      // no work folder, no placement, no collision prompt.
      const target = worktreeTarget
        ? { repo: worktreeTarget.repo, worktreePath: worktreeTarget.path }
        : { repo: repo || "local-folder", workFolder, ...(placement ? { placement } : {}) };
      const res = await fetch(prefix("/api/agents/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend,
          ...target,
          prompt: prompt.trim(),
          ...(Object.keys(config).length > 0 ? { config } : {}),
          ...(modeChanged && modeId ? { modeId } : {}),
          attachments: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data })),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);

      // The folder is already in use by a live (or idle-but-steerable)
      // session — ask, don't start. Keep the prompt intact.
      if (data.collision) {
        setCollision(data.active);
        return;
      }

      setPrompt("");
      setAttachments([]);
      onClearWorktreeTarget?.();
      if (data.id) {
        router.push(prefix(`/agents/${data.id}`));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const quickTemplates = [
    "Explain architecture and main entry points",
    "Audit routes and verify API contracts",
    "Fix build errors and typescript issues",
    "Refactor UI layout and clean code",
  ];

  // On a remote deployment (prod), the composer below is SERVER-backed — its
  // CLI detection and session-create hit this deployment, i.e. they'd run the
  // agent on the server and show the server's CLIs. That contradicts "tasks
  // run on the CLIs on your machine" and the local-control-plane/remote-brain
  // design. Until execution is wired to the user's localhost (C2), gate it:
  // show this machine's connection state instead of a run surface that runs on
  // the server. In local mode same-origin IS the local machine, so the
  // composer is correct — render it as-is.
  if (mode === "prod") return <LocalExecutionCard />;

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* Top row: local folder (left) + engine chips (right) */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/* Target — TOP LEFT: an existing separate copy when one is picked
            ("+ new session" on a copy card), otherwise the local folder. */}
        {worktreeTarget ? (
          <div className="flex items-center gap-1.5 bg-cream/70 px-2.5 py-1.5 rounded-lg border border-line min-w-0 max-w-[45%]">
            <span className="text-xs">⎇</span>
            <span className="text-[11px] font-mono text-ink truncate flex-1" title={worktreeTarget.path}>
              {worktreeTarget.branch ?? worktreeTarget.path.split("/").pop()}
            </span>
            <span className="text-[10px] font-mono text-text-muted flex-shrink-0">separate copy</span>
            <button
              type="button"
              onClick={() => onClearWorktreeTarget?.()}
              className="text-[12px] font-bold text-text-muted hover:text-ink ml-1 cursor-pointer flex-shrink-0"
              title="Back to picking a local folder"
            >
              ×
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 bg-cream/70 px-2.5 py-1.5 rounded-lg border border-line min-w-0 max-w-[45%]">
            <span className="text-xs flex-shrink-0">📁</span>
            {/* End folder name + chevron. When other folders exist, a transparent
                native <select> overlays the whole label so the dropdown feels normal. */}
            <div className="relative flex items-center gap-1 min-w-0">
              <span className="text-[11px] font-mono text-ink truncate" title={workFolder}>
                {workFolder ? workFolder.split("/").filter(Boolean).pop() : "Choose local folder..."}
              </span>
              {workFolders.length > 0 && (
                <>
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="w-3 h-3 text-text-muted flex-shrink-0"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <select
                    value={workFolder}
                    onChange={(e) => {
                      const selected = e.target.value;
                      setWorkFolder(selected);
                      const match = workFolders.find((f) => f.path === selected);
                      if (match?.repo) setRepo(match.repo);
                    }}
                    className="absolute inset-0 w-full opacity-0 cursor-pointer"
                    title="Switch local folder"
                  >
                    {workFolders.map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setIsFolderPickerOpen(true)}
              className="text-text-muted hover:text-ink ml-1 cursor-pointer flex-shrink-0"
              title="Add a new folder"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-3.5 h-3.5"
              >
                <path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-7.5l-2-2H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1Z" />
                <path d="M12 11v6M9 14h6" />
              </svg>
            </button>
          </div>
        )}

        {/* Agent Engine Selector Chips — TOP RIGHT (green dot = ready) */}
        <div className="flex items-center gap-1 bg-cream/90 p-1 rounded-lg border border-line">
          {agents.map((a) => {
            const isSelected = backend === a.id;
            const brand = AGENT_BRANDS[a.id];
            return (
              <button
                key={a.id}
                type="button"
                disabled={!a.installed}
                onClick={() => setBackend(a.id)}
                title={
                  a.installed
                    ? `${a.name} ${a.version ? `(${a.version})` : "Ready"}`
                    : `${a.name} - Not installed (${a.installHint ?? ""})`
                }
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-all ${
                  isSelected
                    ? "bg-ink text-paper shadow-xs font-semibold"
                    : "text-ink hover:bg-sand/60"
                } ${!a.installed ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
              >
                {brand && (
                  <BrandIcon
                    name={brand}
                    size={13}
                    className={isSelected ? "text-paper" : "text-ink"}
                  />
                )}
                <span>{a.name.split(" ")[0]}</span>
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    a.installed ? "bg-ok" : "bg-text-muted/40"
                  }`}
                />
              </button>
            );
          })}
        </div>
      </div>

      <form onSubmit={handleStartTask} className="flex flex-col gap-2.5">
        {/* Main Text Box Container — overflow visible so ExpandablePill
            dropdowns render above the bar without being clipped. */}
        <div className="relative rounded-xl border border-line bg-paper p-3.5 shadow-xs focus-within:border-ink/40 transition-all flex flex-col gap-3">
          {/* Attached Files & Screenshots Thumbnails Strip */}
          {attachments.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap pb-2.5 border-b border-line">
              {attachments.map((att, idx) => (
                <div
                  key={idx}
                  className="relative group flex items-center gap-2 p-1.5 pr-2 rounded-lg border border-line bg-cream text-[11px] font-mono"
                >
                  {att.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="w-8 h-8 rounded object-cover border border-line"
                    />
                  ) : (
                    <span className="text-sm">📄</span>
                  )}
                  <div className="min-w-0 max-w-[140px]">
                    <div className="truncate text-ink font-medium">{att.name}</div>
                    <div className="text-[9px] text-text-muted">{formatBytes(att.size)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAttachment(idx)}
                    className="ml-1 text-text-muted hover:text-ink text-xs font-bold px-1 cursor-pointer"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Mention Textarea */}
          <MentionTextarea
            value={prompt}
            onChange={setPrompt}
            fetchFiles={fetchFiles}
            onPaste={handlePaste}
            placeholder="Describe what task or feature to implement... (@ to tag files, paste or attach screenshots)"
            rows={compact ? 3 : 4}
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-text-muted/60 focus:outline-none resize-none border-none p-0"
          />
        </div>

        {/* Bottom bar — OUTSIDE the box so expanded cards aren't clipped.
            Attach left | model/mode/effort pills center | Run fixed right. */}
        <div className="flex items-center justify-between gap-2">
          {/* Attach — LEFT */}
          <div className="flex-shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.png,.jpg,.jpeg,.webp,.pdf,.txt"
              className="hidden"
              onChange={handleFileInputChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-line bg-cream text-[11.5px] text-text-muted hover:text-ink transition font-mono cursor-pointer"
              title="Attach images or context files"
            >
              <span>📎</span>
              <span>Attach</span>
            </button>
          </div>

          {/* ACP config pills — CENTER (model name + mode/effort toggles) */}
          <div className="min-w-0 flex-1 flex justify-center">
            {optionsLoading ? (
              <span className="text-[10.5px] text-text-muted font-mono animate-pulse">
                Loading agent options…
              </span>
            ) : (
              <AgentConfigControls
                compact
                configOptions={configOptions}
                modes={modes}
                values={configValues}
                modeValue={modeId}
                onChange={handleConfigChange}
                onModeChange={handleModeChange}
                disabled={starting}
              />
            )}
          </div>

          {/* Run Agent Task — FIXED RIGHT */}
          <div className="flex-shrink-0">
            <Button
              type="submit"
              variant="primary"
              disabled={!prompt.trim() || starting || !backend}
              arrow
              className="py-1.5 px-4 text-[12.5px] font-medium"
            >
              {starting ? "Starting Task..." : "Run Agent Task"}
            </Button>
          </div>
        </div>

        {/* Quick Templates */}
        {!prompt && (
          <div className="flex items-center gap-1.5 flex-wrap px-1 pt-1">
            <span className="text-[10px] text-text-muted font-mono uppercase">Quick:</span>
            {quickTemplates.map((tmpl) => (
              <button
                key={tmpl}
                type="button"
                onClick={() => setPrompt(tmpl)}
                className="text-[10.5px] font-mono px-2 py-0.5 rounded-md bg-sand border border-line text-text-muted hover:text-ink hover:border-ink/30 transition-colors cursor-pointer"
              >
                {tmpl}
              </button>
            ))}
          </div>
        )}

        {error && <p className="text-[12px] text-warn font-medium px-1">{error}</p>}

        {/* Collision prompt — another live session is already working in this
            folder. Offer a separate copy (primary) so they don't overwrite
            each other, or sharing the same folder anyway. */}
        {collision && (
          <div className="rounded-lg border border-line bg-cream/60 px-4 py-3">
            <p className="text-[13px] text-ink mb-3">
              Session “{collision.title}” is already working in this folder. Run this one on a
              separate copy of the branch so they don’t overwrite each other?
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                type="button"
                onClick={() => handleStartTask(undefined, "separate_copy")}
                disabled={starting}
                arrow
              >
                {starting ? "Starting…" : "Separate copy"}
              </Button>
              <button
                type="button"
                onClick={() => handleStartTask(undefined, "in_place")}
                disabled={starting}
                className="rounded-lg border border-line bg-paper px-3.5 py-2 text-[13px] text-text hover:bg-cream transition disabled:opacity-50 cursor-pointer"
              >
                Same folder anyway
              </button>
              <button
                type="button"
                onClick={() => setCollision(null)}
                disabled={starting}
                className="text-[12px] text-text-muted hover:text-ink transition ml-1 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </form>

      {/* File System Picker Dialog */}
      {isFolderPickerOpen && (
        <FolderPickerDialog
          onSelect={handleSelectFolder}
          onClose={() => setIsFolderPickerOpen(false)}
        />
      )}
    </div>
  );
}

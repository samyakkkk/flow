"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/useProject";
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

interface AgentTaskComposerProps {
  nodeCount?: number;
  selectedNodeTag?: string | null;
  onClearNodeTag?: () => void;
  compact?: boolean;
  className?: string;
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
}: AgentTaskComposerProps) {
  const router = useRouter();
  const { prefix } = useProject();

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

  // Autocomplete files from repo/folder
  const fetchFiles = useCallback(
    (q: string) => {
      if (!repo) return Promise.resolve([]);
      const folderParam = workFolder ? `&folder=${encodeURIComponent(workFolder)}` : "";
      return fetch(
        prefix(`/api/agents/repos/files?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(q)}${folderParam}`)
      )
        .then((r) => (r.ok ? r.json() : { entries: [] }))
        .then((d: { entries?: FileEntry[] }) => d.entries ?? []);
    },
    [repo, workFolder, prefix]
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

  // Launch Agent Task
  const handleStartTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || starting) return;

    if (!workFolder) {
      setError("Please choose a local folder to run the agent task in.");
      setIsFolderPickerOpen(true);
      return;
    }

    setStarting(true);
    setError("");

    try {
      const res = await fetch(prefix("/api/agents/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend,
          repo: repo || "local-folder",
          workFolder,
          prompt: prompt.trim(),
          ...(Object.keys(config).length > 0 ? { config } : {}),
          ...(modeChanged && modeId ? { modeId } : {}),
          attachments: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data })),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);

      setPrompt("");
      setAttachments([]);
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

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* Top row: local folder (left) + engine chips (right) */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/* Local Folder Target — TOP LEFT */}
        <div className="flex items-center gap-1.5 bg-cream/70 px-2.5 py-1.5 rounded-lg border border-line min-w-0 max-w-[45%]">
          <span className="text-xs">📁</span>
          <span className="text-[11px] font-mono text-ink truncate flex-1" title={workFolder}>
            {workFolder ? workFolder : "Choose local folder..."}
          </span>
          {workFolders.length > 0 && (
            <select
              value={workFolder}
              onChange={(e) => {
                const selected = e.target.value;
                setWorkFolder(selected);
                const match = workFolders.find((f) => f.path === selected);
                if (match?.repo) setRepo(match.repo);
              }}
              className="bg-transparent border-none text-[10px] font-mono text-text-muted outline-none cursor-pointer w-4 flex-shrink-0"
              title="Switch local folder"
            >
              {workFolders.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setIsFolderPickerOpen(true)}
            className="text-[10px] font-mono text-text-muted hover:text-ink underline ml-1 cursor-pointer flex-shrink-0"
          >
            Change
          </button>
        </div>

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
        {/* Main Text Box Container */}
        <div className="rounded-xl border border-line bg-paper p-3.5 shadow-xs focus-within:border-ink/40 transition-all flex flex-col gap-3">
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

          {/* Bottom bar inside the text box: ACP config controls (left) +
              attach & run (right). Model/thinking/mode selectors are whatever
              the selected agent advertises — nothing hardcoded. */}
          <div className="flex items-center justify-between gap-2 pt-3 border-t border-line/70 flex-wrap">
            {/* Model / thinking / mode controls — BOTTOM LEFT */}
            <div className="min-w-0">
              {optionsLoading ? (
                <span className="text-[10.5px] text-text-muted font-mono animate-pulse">
                  Loading agent options…
                </span>
              ) : (
                <AgentConfigControls
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

            {/* Attachment Button & Run Agent Task CTA — BOTTOM RIGHT */}
            <div className="flex items-center gap-2 flex-shrink-0">
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

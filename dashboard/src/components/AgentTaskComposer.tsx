"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/useProject";
import { Kicker, Button, StatusPill } from "@/components/ui";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";
import { MentionTextarea, type FileEntry } from "@/components/MentionTextarea";
import { FolderPickerDialog } from "@/components/FolderPickerDialog";

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

const MODEL_OPTIONS: Record<string, { id: string; label: string }[]> = {
  claude: [
    { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet" },
    { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
    { id: "claude-3-5-haiku", label: "Claude 3.5 Haiku" },
  ],
  codex: [
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "o3-mini", label: "o3-mini" },
    { id: "o1", label: "o1" },
  ],
  opencode: [
    { id: "opencode-default", label: "Default Model" },
  ],
};

function formatBytes(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AgentTaskComposer({
  nodeCount = 0,
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

  const [backend, setBackend] = useState("claude");
  const [model, setModel] = useState("claude-3-7-sonnet");
  const [thinking, setThinking] = useState(true);

  // Active work folder & target repo
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

      // Default backend
      const defaultBackend = detected.find((x: DetectedAgent) => x.installed)?.id || "claude";
      setBackend((prev) => prev || defaultBackend);

      // Default active local folder
      // Priority 1: First registered work folder
      // Priority 2: First local folder source (surface === "folder")
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

  // Sync model options when backend engine changes
  useEffect(() => {
    const opts = MODEL_OPTIONS[backend] || MODEL_OPTIONS.claude;
    setModel(opts[0].id);
  }, [backend]);

  // Handle local folder selection from FolderPickerDialog
  const handleSelectFolder = async (path: string) => {
    setIsFolderPickerOpen(false);
    setError("");
    try {
      // Register folder via /api/work-folders
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
        // ignore failed file
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

    // Build prompt payload with model and thinking annotations if specified
    const promptHeader = `[Model: ${model}${thinking ? " | Thinking: Enabled" : ""}]\n\n`;
    const fullPrompt = `${promptHeader}${prompt.trim()}`;

    try {
      const res = await fetch(prefix("/api/agents/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend,
          repo: repo || "local-folder",
          workFolder,
          prompt: fullPrompt,
          model,
          thinking,
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
    <div className={`flex flex-col gap-4 ${className}`}>
      {/* 1. Header Engine & Local Folder Bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/* Agent Engine Selector Chips */}
        <div className="flex items-center gap-1.5 bg-cream/80 p-1 rounded-xl border border-line">
          {agents.map((a) => {
            const isSelected = backend === a.id;
            const brand = AGENT_BRANDS[a.id];
            return (
              <button
                key={a.id}
                type="button"
                disabled={!a.installed}
                onClick={() => setBackend(a.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
                  isSelected
                    ? "bg-ink text-paper shadow-xs font-semibold"
                    : "text-ink hover:bg-sand/60"
                } ${!a.installed ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
              >
                {brand && (
                  <BrandIcon
                    name={brand}
                    size={14}
                    className={isSelected ? "text-paper" : "text-ink"}
                  />
                )}
                <span>{a.name.split(" ")[0]}</span>
              </button>
            );
          })}
        </div>

        {/* Model & Thinking Toggles */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Model Selector */}
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-lg border border-line bg-cream px-2.5 py-1.5 text-[12px] text-ink font-mono focus:outline-none focus:border-ink/30 cursor-pointer"
          >
            {(MODEL_OPTIONS[backend] || MODEL_OPTIONS.claude).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          {/* Thinking Toggle */}
          <button
            type="button"
            onClick={() => setThinking(!thinking)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11.5px] font-mono transition-colors ${
              thinking
                ? "bg-accent/10 border-accent/40 text-ink font-medium"
                : "bg-cream border-line text-text-muted hover:text-ink"
            }`}
            title="Toggle Thinking / Reasoning Mode"
          >
            <span>🧠</span>
            <span>Thinking {thinking ? "On" : "Off"}</span>
          </button>
        </div>
      </div>

      {/* 2. Target Local Folder Row */}
      <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl border border-line bg-sand/40">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm">📁</span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase font-mono tracking-wider text-text-muted">
              Working Folder Target
            </div>
            <div className="text-[12px] font-mono text-ink font-medium truncate">
              {workFolder ? workFolder : "No local folder selected"}
            </div>
          </div>
        </div>

        {/* Folder Select Dropdown or File Picker Trigger */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {workFolders.length > 0 && (
            <select
              value={workFolder}
              onChange={(e) => {
                const selected = e.target.value;
                setWorkFolder(selected);
                const match = workFolders.find((f) => f.path === selected);
                if (match?.repo) setRepo(match.repo);
              }}
              className="rounded-lg border border-line bg-paper px-2 py-1 text-[11.5px] text-ink font-mono outline-none focus:border-ink/30 max-w-[180px]"
            >
              {workFolders.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path.split("/").pop()} ({f.path})
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={() => setIsFolderPickerOpen(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-line bg-paper text-[12px] text-ink hover:bg-cream transition font-medium cursor-pointer"
          >
            <span>Choose Folder...</span>
          </button>
        </div>
      </div>

      {/* 3. Main Text Area Container (Lovable / v0 / Cursor style) */}
      <form onSubmit={handleStartTask} className="flex flex-col gap-2">
        <div className="rounded-xl border border-line bg-paper p-3 shadow-xs focus-within:border-ink/40 transition-all flex flex-col gap-2.5">
          {/* Attached Files & Screenshots Thumbnails */}
          {attachments.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap pb-2 border-b border-line">
              {attachments.map((att, idx) => (
                <div
                  key={idx}
                  className="relative group flex items-center gap-2 p-1.5 pr-2 rounded-lg border border-line bg-cream text-[11px] font-mono"
                >
                  {att.previewUrl ? (
                    // Image Thumbnail
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
                    className="ml-1 text-text-muted hover:text-ink text-xs font-bold px-1"
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

          {/* Bottom Action Bar inside Text Box */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-line/60 flex-wrap">
            {/* Attachment Button */}
            <div className="flex items-center gap-2">
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
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-line bg-cream text-[11.5px] text-text-muted hover:text-ink transition font-mono cursor-pointer"
                title="Attach images or context files"
              >
                <span>📎</span>
                <span>Attach</span>
              </button>

              <span className="text-[10px] text-text-muted font-mono hidden sm:inline">
                @ for files · Paste screenshots
              </span>
            </div>

            {/* Run Task Button */}
            <Button
              type="submit"
              variant="primary"
              disabled={!prompt.trim() || starting}
              arrow
              className="py-1.5 px-4 text-[13px] font-medium"
            >
              {starting ? "Starting Task..." : "Run Agent Task"}
            </Button>
          </div>
        </div>

        {/* Quick Templates */}
        {!prompt && (
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
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

        {error && <p className="text-[12px] text-warn font-medium mt-1">{error}</p>}
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

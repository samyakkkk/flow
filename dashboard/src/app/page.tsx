"use client";
import { Shell } from "@/components/Shell";
import { KeyGate } from "@/components/KeyGate";
import { BrainGraph } from "@/components/BrainGraph";
import { Kicker, Heading, Button, StatusPill, Card } from "@/components/ui";
import { useEffect, useState, useCallback, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMode } from "@/lib/useMode";
import Link from "next/link";
import { BrandIcon } from "@/components/BrandIcon";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SettingItem {
  key: string;
  set: boolean;
  value?: string | null;
}

interface IngestSource {
  source: string;
  resource: string;
  catching_up: boolean;
  lag_seconds: number | null;
  last_poll_at: number;
  status: string;
}

interface RepoEntry {
  name: string;
  url: string;
  branch: string;
  lastIndexedAt?: string;
  lastIndexedCommit?: string;
  addedAt?: string;
}

interface AuditRow {
  id: number;
  classification?: string;
  action?: string;
  target?: string;
  status?: string;
  source?: string;
  ts?: number;
  detail?: string | null;
  created_at?: number;
}

interface GhRepo {
  full_name: string;
  url: string;
  default_branch: string;
}

type HomeState = "loading" | "engine-down" | "no-brain" | "empty" | "building" | "alive";

// ─── Humanized translations ────────────────────────────────────────────────────

function extractDetailName(detail: string | null | undefined): string | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    // Prefer repo, then name, then first string value
    if (typeof parsed.repo === "string") return parsed.repo;
    if (typeof parsed.name === "string") return parsed.name;
    const firstStr = Object.values(parsed).find((v) => typeof v === "string");
    return typeof firstStr === "string" ? firstStr : null;
  } catch {
    return null;
  }
}

function humanizeActivity(row: AuditRow): string | null {
  const cls = row.classification ?? "";
  const action = row.action ?? "";
  const status = row.status ?? "";
  // Prefer a human name extracted from detail JSON over the raw target (which may be a UUID)
  const detailName = extractDetailName(row.detail);
  const target = detailName ?? row.target ?? row.source ?? "";

  // Hide noise entirely
  if (cls === "noise" || action === "suppress" || status === "suppressed") return null;

  if (cls === "knowledge_claim" && action === "graph_write") {
    return target ? `Learned a fact from ${target}` : "Learned a new fact";
  }
  if (cls === "knowledge_claim" || action === "graphwrite" || action === "graph_write") {
    return target ? `Learned something from ${target}` : "Learned a new fact";
  }
  if ((cls === "index_job" || action === "index_repo") && status === "ok") {
    return target ? `Indexed ${target}` : "Indexed a repository";
  }
  if (cls === "index_job" || action === "index_repo") {
    return target ? `Indexing ${target}` : "Indexing a repository";
  }
  if (cls === "task_discussion" && action === "propose") {
    return `Suggested a ticket — review pending`;
  }
  if (cls === "repo_added" || action === "repo_added") {
    return target ? `Connected ${target} — indexing now` : "Connected a new repository";
  }
  if (action === "decision" || cls === "decision") {
    return target ? `Noted a decision from ${target}` : "Captured a decision";
  }
  if (cls === "correction") {
    return "Applied a correction to the knowledge base";
  }
  if (cls === "meeting_segment" && action === "decision") {
    return target ? `Captured a meeting decision from ${target}` : "Captured a meeting decision";
  }
  if (status === "ok" && target) {
    return `Updated ${target}`;
  }

  return null; // Skip untranslatable rows
}


function sourceLabel(s: IngestSource): string {
  const names: Record<string, string> = { github: "GitHub", linear: "Linear", fireflies: "Fireflies" };
  const pretty = names[s.source] ?? s.source;
  return s.resource && s.resource !== "_all" ? `${pretty} · ${s.resource}` : pretty;
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function lagLabel(lag: number | null): string {
  if (lag === null) return "never polled";
  if (lag < 60) return "up to date";
  if (lag < 3600) return `${Math.round(lag / 60)}m behind`;
  return `${Math.round(lag / 3600)}h behind`;
}

// Derives per-repo indexing status.
// Signal: lastIndexedCommit === null/undefined → the repo has been registered
// but hasn't completed its first index pass yet → "indexing" or "queued".
// This is orchestrator-free and reads directly from repos.json via /api/repos.
function repoIndexStatus(repo: RepoEntry): "indexing" | "indexed" | "queued" {
  if (!repo.lastIndexedCommit) {
    // No commit recorded yet — treat as queued/indexing
    return "queued";
  }
  return "indexed";
}

// ─── Now-Indexing Panel ───────────────────────────────────────────────────────

function NowIndexingPanel() {
  const [sources, setSources] = useState<IngestSource[]>([]);

  const fetch_ = useCallback(() => {
    fetch("/api/ingest/status")
      .then((r) => r.json())
      .then((d: { sources?: IngestSource[] }) => setSources(d.sources ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch_();
    const iv = setInterval(fetch_, 5000);
    return () => clearInterval(iv);
  }, [fetch_]);

  if (sources.length === 0) return null;

  return (
    <div className="space-y-2">
      {sources.map((s, i) => {
        const isLive = s.catching_up;
        const label = isLive
          ? `Reading ${sourceLabel(s)}…`
          : `${sourceLabel(s)} — up to date`;
        const lagStr = lagLabel(s.lag_seconds);

        return (
          <div
            key={i}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
            style={{ background: "var(--sand)", border: "1px solid var(--line)" }}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <StatusPill kind={isLive ? "live" : "ok"}>
                {isLive ? "Indexing" : "Done"}
              </StatusPill>
              <span className="text-[13px] text-text truncate">{label}</span>
            </div>
            <span
              style={{ fontFamily: "var(--font-mono)" }}
              className="text-[10px] text-text-muted flex-shrink-0"
            >
              {lagStr}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Source Card (State 1 base card) ─────────────────────────────────────────

interface SourceCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  locked?: boolean;
  lockReason?: string;
  children?: React.ReactNode;
  onClick?: () => void;
}

function SourceCard({ icon, title, description, locked, lockReason, children, onClick }: SourceCardProps) {
  return (
    <div
      className={`rounded-xl border p-5 flex flex-col gap-3 transition-all ${
        locked
          ? "bg-paper border-line opacity-50 cursor-not-allowed"
          : "bg-paper border-line hover:border-ink/20 hover:shadow-sm cursor-pointer"
      }`}
      onClick={locked ? undefined : onClick}
      style={{
        ...(locked ? {} : { transition: "border-color 0.15s, box-shadow 0.15s" }),
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-2xl text-ink flex items-center">{icon}</span>
          <div>
            <div style={{ fontFamily: "var(--font-display)" }} className="text-ink text-[15px] font-medium">
              {title}
            </div>
            <div className="text-text-muted text-[12px] mt-0.5">{description}</div>
          </div>
        </div>
        {locked && (
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="flex-shrink-0 text-[9px] uppercase tracking-wider px-2 py-1 rounded-full bg-sand text-text-muted border border-line"
          >
            Locked
          </span>
        )}
      </div>
      {lockReason && (
        <p className="text-[11px] text-text-muted">{lockReason}</p>
      )}
      {children && !locked && (
        <div onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Repo Picker (shared between State 1 GitHubCard and Home GitHub management) ──

interface RepoPickerPanelProps {
  onConnected: () => void;
  onClose?: () => void;
}

function RepoPickerPanel({ onConnected, onClose }: RepoPickerPanelProps) {
  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [repoSrc, setRepoSrc] = useState<"gh_cli" | "pat" | "none">("none");
  const [pat, setPat] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setLoading(true);
    fetch("/api/github/repos")
      .then((r) => r.json())
      .then((d: { source: "gh_cli" | "pat" | "none"; repos: GhRepo[] }) => {
        setRepoSrc(d.source);
        setRepos(d.repos ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSavePat(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch("/api/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_pat", pat }),
      });
      setPat("");
      setLoading(true);
      const r = await fetch("/api/github/repos");
      const d = await r.json() as { source: "gh_cli" | "pat" | "none"; repos: GhRepo[] };
      setRepoSrc(d.source);
      setRepos(d.repos ?? []);
    } finally {
      setSaving(false);
      setLoading(false);
    }
  }

  async function handleAdd() {
    if (selected.size === 0) return;
    setSaving(true);
    setMsg("");
    const toAdd = repos.filter((r) => selected.has(r.full_name));
    try {
      const res = await fetch("/api/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_repos", repos: toAdd }),
      });
      const data = await res.json() as { ok: boolean; results?: Array<{ ok: boolean }> };
      if (data.ok) {
        const count = (data.results ?? []).filter((r) => r.ok).length;
        setMsg(`${count} repo${count !== 1 ? "s" : ""} connected — indexing will start soon.`);
        setSelected(new Set());
        onConnected();
      }
    } catch {
      setMsg("Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-text-muted text-[13px]">Loading your repositories…</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {repoSrc === "none" ? (
        <form onSubmit={handleSavePat} className="flex flex-col gap-3">
          <p className="text-[13px] text-text-muted">
            Paste a GitHub fine-grained PAT (repo read access) to list your repos.
          </p>
          <input
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="github_pat_…"
            className="w-full rounded-md border border-line bg-cream px-4 py-2.5 text-[14px] text-text placeholder:text-text-muted/60 outline-none focus:border-ink/20"
          />
          <Button type="submit" disabled={!pat.trim() || saving} arrow>
            {saving ? "Connecting…" : "Connect GitHub"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-text-muted">
            {repos.length} repos available via {repoSrc === "gh_cli" ? "gh CLI" : "GitHub PAT"}.
            Select to connect.
          </p>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-line">
            {repos.slice(0, 60).map((repo) => (
              <label
                key={repo.full_name}
                className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-sand border-b border-line last:border-b-0 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(repo.full_name)}
                  onChange={() => setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(repo.full_name)) next.delete(repo.full_name);
                    else next.add(repo.full_name);
                    return next;
                  })}
                  className="w-3.5 h-3.5"
                  style={{ accentColor: "var(--accent)" }}
                />
                <span
                  style={{ fontFamily: "var(--font-mono)" }}
                  className="text-[12px] text-text"
                >
                  {repo.full_name}
                </span>
              </label>
            ))}
          </div>
          {selected.size > 0 && (
            <Button onClick={handleAdd} disabled={saving} arrow>
              {saving ? "Connecting…" : `Connect ${selected.size} repo${selected.size !== 1 ? "s" : ""}`}
            </Button>
          )}
        </div>
      )}
      {msg && <p className="text-[12px] text-text-muted">{msg}</p>}
      {onClose && (
        <button
          onClick={onClose}
          className="self-start text-[11px] text-text-muted hover:text-ink transition mt-1"
          style={{ fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}
        >
          Cancel
        </button>
      )}
    </div>
  );
}

// ─── GitHub Card (State 1 — no repos yet) ────────────────────────────────────

function GitHubCard({ onConnected }: { onConnected: () => void }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <SourceCard
        icon={<BrandIcon name="github" size={20} />}
        title="GitHub"
        description="Pick repositories to understand."
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <div className="rounded-xl border border-ink/20 bg-paper p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BrandIcon name="github" size={18} className="text-ink" />
          <span style={{ fontFamily: "var(--font-display)" }} className="text-ink text-[15px] font-medium">
            GitHub
          </span>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-text-muted hover:text-ink text-sm transition"
        >
          ✕
        </button>
      </div>
      <RepoPickerPanel onConnected={onConnected} onClose={() => setOpen(false)} />
    </div>
  );
}

// ─── Simple key-paste card ────────────────────────────────────────────────────

function ApiKeyCard({
  icon,
  title,
  description,
  settingKey,
  placeholder,
  onConnected,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  settingKey: string;
  placeholder: string;
  onConnected: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingKey]: value.trim() }),
      });
      setDone(true);
      setValue("");
      setTimeout(() => {
        setOpen(false);
        onConnected();
      }, 800);
    } catch {
      // swallow — best effort
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <SourceCard
        icon={icon}
        title={title}
        description={description}
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <div className="rounded-xl border border-ink/20 bg-paper p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl text-ink flex items-center">{icon}</span>
          <span style={{ fontFamily: "var(--font-display)" }} className="text-ink text-[15px] font-medium">
            {title}
          </span>
        </div>
        <button onClick={() => setOpen(false)} className="text-text-muted hover:text-ink text-sm transition">✕</button>
      </div>
      {done ? (
        <p className="text-[13px] text-text">Connected. Starting sync…</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <p className="text-[13px] text-text-muted">{description}</p>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            autoFocus
            className="w-full rounded-md border border-line bg-cream px-4 py-2.5 text-[14px] text-text placeholder:text-text-muted/60 outline-none focus:border-ink/20"
          />
          <Button type="submit" disabled={!value.trim() || saving} arrow>
            {saving ? "Saving…" : "Connect"}
          </Button>
        </form>
      )}
    </div>
  );
}

// ─── Meeting Notes Card ───────────────────────────────────────────────────────

function MeetingNotesCard({ onConnected }: { onConnected: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "meeting_notes", title: title || "Manual upload", text }),
      });
      setDone(true);
      setTimeout(() => {
        setOpen(false);
        onConnected();
      }, 900);
    } catch {
      // swallow
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <SourceCard
        icon="📝"
        title="Meeting notes"
        description="Paste a transcript or notes to extract decisions."
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <div className="rounded-xl border border-ink/20 bg-paper p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">📝</span>
          <span style={{ fontFamily: "var(--font-display)" }} className="text-ink text-[15px] font-medium">
            Meeting notes
          </span>
        </div>
        <button onClick={() => setOpen(false)} className="text-text-muted hover:text-ink text-sm transition">✕</button>
      </div>
      {done ? (
        <p className="text-[13px] text-text">Notes ingested. Flow is extracting decisions…</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            className="w-full rounded-md border border-line bg-cream px-4 py-2.5 text-[14px] text-text placeholder:text-text-muted/60 outline-none focus:border-ink/20"
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste transcript or notes here…"
            rows={6}
            className="w-full rounded-md border border-line bg-cream px-4 py-3 text-[13px] text-text placeholder:text-text-muted/60 outline-none focus:border-ink/20 resize-y"
          />
          <Button type="submit" disabled={!text.trim() || saving} arrow>
            {saving ? "Ingesting…" : "Ingest notes"}
          </Button>
        </form>
      )}
    </div>
  );
}

// ─── Home GitHub Management Card (State 2/3) ──────────────────────────────────
// Shows connected repos by name with per-repo status, plus "Add repositories" affordance.

function HomeGitHubCard({
  repos,
  onRepoAdded,
}: {
  repos: RepoEntry[];
  onRepoAdded: () => void;
}) {
  const [showPicker, setShowPicker] = useState(false);

  return (
    <div
      className="rounded-xl border border-line bg-paper p-5 flex flex-col gap-4"
      data-testid="home-github-card"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <BrandIcon name="github" size={18} className="text-ink" />
          <div>
            <div style={{ fontFamily: "var(--font-display)" }} className="text-ink text-[15px] font-medium">
              GitHub
            </div>
            <div className="text-text-muted text-[11px] mt-0.5">
              {repos.length === 0
                ? "No repositories connected"
                : `${repos.length} repositor${repos.length === 1 ? "y" : "ies"} connected`}
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowPicker((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-line text-text-muted text-[11px] hover:border-ink/20 hover:text-ink transition-colors"
          style={{ fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}
          data-testid="add-repos-affordance"
        >
          {showPicker ? "Close" : "+ Add repositories"}
        </button>
      </div>

      {/* Connected repos list */}
      {repos.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {repos.map((repo, i) => {
            const status = repoIndexStatus(repo);
            return (
              <div
                key={i}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
                style={{ background: "var(--sand)", border: "1px solid var(--line)" }}
                data-testid="repo-item"
              >
                <span
                  style={{ fontFamily: "var(--font-mono)" }}
                  className="text-[12px] text-text truncate"
                >
                  {repo.name}
                </span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {status === "indexed" ? (
                    <StatusPill kind="ok">Indexed</StatusPill>
                  ) : status === "queued" ? (
                    <StatusPill kind="live">Indexing</StatusPill>
                  ) : (
                    <StatusPill kind="warn">Failed</StatusPill>
                  )}
                  {repo.lastIndexedAt && status === "indexed" && (
                    <span
                      style={{ fontFamily: "var(--font-mono)" }}
                      className="text-[10px] text-text-muted hidden sm:inline"
                    >
                      {timeAgo(new Date(repo.lastIndexedAt).getTime())}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Repo picker inline expansion */}
      {showPicker && (
        <div
          className="border-t border-line pt-4"
          data-testid="repo-picker-expanded"
        >
          <p
            style={{ fontFamily: "var(--font-mono)" }}
            className="text-[10px] uppercase tracking-wider text-text-muted mb-3"
          >
            Select repositories to add
          </p>
          <RepoPickerPanel
            onConnected={() => {
              setShowPicker(false);
              onRepoAdded();
            }}
            onClose={() => setShowPicker(false)}
          />
        </div>
      )}
    </div>
  );
}

// ─── Home Source Management (State 2/3) ───────────────────────────────────────
// Replaces old SourcesRail. Full source management lives here.

interface HomeSourcesProps {
  repos: RepoEntry[];
  settings: SettingItem[];
  onSourceChanged: () => void;
}

function HomeSourcesPanel({ repos, settings, onSourceChanged }: HomeSourcesProps) {
  const linearSet = settings.some((s) => s.key === "LINEAR_API_KEY" && s.set);
  const firefliesSet = settings.some((s) => s.key === "FIREFLIES_API_KEY" && s.set);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Kicker>Sources</Kicker>
        <Link
          href="/connections"
          className="text-[10px] text-text-muted hover:text-ink transition-colors"
          style={{ fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}
        >
          Manage all ↗
        </Link>
      </div>

      {/* GitHub repos management card */}
      <HomeGitHubCard repos={repos} onRepoAdded={onSourceChanged} />

      {/* Linear */}
      <InlineKeySourceCard
        icon={<BrandIcon name="linear" size={20} />}
        title="Linear"
        description="Sync tickets and project context."
        connected={linearSet}
        settingKey="LINEAR_API_KEY"
        placeholder="lin_api_…"
        onConnected={onSourceChanged}
      />

      {/* Fireflies */}
      <InlineKeySourceCard
        icon={<BrandIcon name="fireflies" size={20} />}
        title="Fireflies"
        description="Bring in meeting decisions and transcripts."
        connected={firefliesSet}
        settingKey="FIREFLIES_API_KEY"
        placeholder="ff_…"
        onConnected={onSourceChanged}
      />

      {/* Meeting notes — always available */}
      <HomeMeetingNotesCard onUploaded={onSourceChanged} />

      {/* Slack — locked */}
      <div
        className="rounded-xl border border-line bg-paper p-4 flex items-center gap-3 opacity-50"
      >
        <BrandIcon name="slack" size={20} className="text-ink" />
        <div className="flex-1 min-w-0">
          <div style={{ fontFamily: "var(--font-display)" }} className="text-ink text-[14px] font-medium">
            Slack
          </div>
          <div className="text-text-muted text-[11px] mt-0.5">Always-on — available once deployed.</div>
        </div>
        <span
          style={{ fontFamily: "var(--font-mono)" }}
          className="flex-shrink-0 text-[9px] uppercase tracking-wider px-2 py-1 rounded-full bg-sand text-text-muted border border-line"
        >
          Locked
        </span>
      </div>
    </div>
  );
}

// ─── Inline Key Source Card (Linear / Fireflies on Home) ─────────────────────

function InlineKeySourceCard({
  icon,
  title,
  description,
  connected,
  settingKey,
  placeholder,
  onConnected,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  connected: boolean;
  settingKey: string;
  placeholder: string;
  onConnected: () => void;
}) {
  const [showInput, setShowInput] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingKey]: value.trim() }),
      });
      setDone(true);
      setValue("");
      setTimeout(() => {
        setShowInput(false);
        onConnected();
      }, 800);
    } catch {
      // swallow
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="rounded-xl border border-line bg-paper p-4 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-xl text-ink flex items-center">{icon}</span>
          <div>
            <div style={{ fontFamily: "var(--font-display)" }} className="text-ink text-[14px] font-medium">
              {title}
            </div>
            <div className="text-text-muted text-[11px] mt-0.5">{description}</div>
          </div>
        </div>
        {connected ? (
          <span
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full flex-shrink-0"
            style={{ background: "rgba(90,140,90,0.1)", border: "1px solid rgba(90,140,90,0.2)" }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-ok" />
            <span
              style={{ fontFamily: "var(--font-mono)" }}
              className="text-[9px] uppercase tracking-wider text-ok"
            >
              Connected
            </span>
          </span>
        ) : (
          <button
            onClick={() => setShowInput((v) => !v)}
            className="flex-shrink-0 text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-full border border-dashed border-line text-text-muted hover:border-ink/20 hover:text-ink transition-colors"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {showInput ? "Cancel" : "Connect"}
          </button>
        )}
      </div>

      {/* Inline key input */}
      {!connected && showInput && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
          {done ? (
            <p className="text-[13px] text-text">Connected. Starting sync…</p>
          ) : (
            <>
              <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
                autoFocus
                className="w-full rounded-md border border-line bg-cream px-4 py-2.5 text-[13px] text-text placeholder:text-text-muted/60 outline-none focus:border-ink/20"
              />
              <Button type="submit" disabled={!value.trim() || saving} arrow>
                {saving ? "Saving…" : "Connect"}
              </Button>
            </>
          )}
        </form>
      )}
    </div>
  );
}

// ─── Home Meeting Notes Card ──────────────────────────────────────────────────

function HomeMeetingNotesCard({ onUploaded }: { onUploaded: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "meeting_notes", title: title || "Manual upload", text }),
      });
      setDone(true);
      setTimeout(() => {
        setShowForm(false);
        setDone(false);
        setTitle(""); setText("");
        onUploaded();
      }, 900);
    } catch {
      // swallow
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-paper p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-xl">📝</span>
          <div>
            <div style={{ fontFamily: "var(--font-display)" }} className="text-ink text-[14px] font-medium">
              Meeting notes
            </div>
            <div className="text-text-muted text-[11px] mt-0.5">Extract decisions from transcripts.</div>
          </div>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex-shrink-0 text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-full border border-dashed border-line text-text-muted hover:border-ink/20 hover:text-ink transition-colors"
          style={{ fontFamily: "var(--font-mono)" }}
          data-testid="upload-notes-affordance"
        >
          {showForm ? "Cancel" : "Upload notes"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
          {done ? (
            <p className="text-[13px] text-text">Notes ingested. Flow is extracting decisions…</p>
          ) : (
            <>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title (optional)"
                className="w-full rounded-md border border-line bg-cream px-4 py-2.5 text-[13px] text-text placeholder:text-text-muted/60 outline-none focus:border-ink/20"
              />
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste transcript or notes here…"
                rows={5}
                className="w-full rounded-md border border-line bg-cream px-4 py-3 text-[12px] text-text placeholder:text-text-muted/60 outline-none focus:border-ink/20 resize-y"
              />
              <Button type="submit" disabled={!text.trim() || saving} arrow>
                {saving ? "Ingesting…" : "Ingest notes"}
              </Button>
            </>
          )}
        </form>
      )}
    </div>
  );
}

// ─── Brain stats ──────────────────────────────────────────────────────────────

function BrainStats({ nodeCount, edgeCount, repoCount, sources }: {
  nodeCount: number;
  edgeCount: number;
  repoCount: number;
  sources: IngestSource[];
}) {
  const lastUpdated = sources.reduce<number>((max, s) => Math.max(max, s.last_poll_at * 1000), 0);

  return (
    <div className="flex items-center gap-6 flex-wrap">
      <div>
        <span style={{ fontFamily: "var(--font-display)" }} className="text-[28px] text-ink font-medium">
          {nodeCount.toLocaleString()}
        </span>
        <span className="text-text-muted text-[13px] ml-2">facts</span>
      </div>
      {repoCount > 0 && (
        <div>
          <span style={{ fontFamily: "var(--font-display)" }} className="text-[28px] text-ink font-medium">
            {repoCount}
          </span>
          <span className="text-text-muted text-[13px] ml-2">
            {repoCount === 1 ? "source" : "sources"}
          </span>
        </div>
      )}
      {lastUpdated > 0 && (
        <div className="text-text-muted text-[13px]">
          updated {timeAgo(lastUpdated)}
        </div>
      )}
    </div>
  );
}

// ─── Recent Activity ──────────────────────────────────────────────────────────

function RecentActivity({ rows }: { rows: AuditRow[] }) {
  const visible = rows
    .map((r) => ({
      human: humanizeActivity(r),
      // created_at from orchestrator is unix seconds; ts (if present) may be millis
      ts: r.ts ?? (r.created_at ? r.created_at * 1000 : undefined),
      id: r.id,
    }))
    .filter((r): r is { human: string; ts: number | undefined; id: number } => r.human !== null)
    .slice(0, 5);

  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <Kicker>Recent activity</Kicker>
      <div className="mt-2 space-y-1.5">
        {visible.map((item) => (
          <div key={item.id} className="flex items-baseline justify-between gap-4">
            <span className="text-[13px] text-text">{item.human}</span>
            {item.ts && (
              <span
                style={{ fontFamily: "var(--font-mono)" }}
                className="text-[10px] text-text-muted flex-shrink-0"
              >
                {timeAgo(item.ts)}
              </span>
            )}
          </div>
        ))}
      </div>
      <Link
        href="/activity"
        className="mt-2 text-[11px] text-text-muted hover:text-ink transition-colors"
        style={{ fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}
      >
        View all activity ↗
      </Link>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [state, setState] = useState<HomeState>("loading");
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [sources, setSources] = useState<IngestSource[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [graphNodeCount, setGraphNodeCount] = useState(0);
  const [graphEdgeCount, setGraphEdgeCount] = useState(0);
  const { mode } = useMode();
  const router = useRouter();

  // Check if brain is set (for KeyGate)
  const hasBrain = settings.some((s) => s.key === "OPENROUTER_API_KEY" && s.set);

  // Derive whether any repo is currently being indexed (no lastIndexedCommit yet)
  const isAnyRepoIndexing = repos.some((r) => !r.lastIndexedCommit);

  // Combined indexing signal: ingest catching_up OR repos without a commit yet
  const isIndexing = sources.some((s) => s.catching_up) || isAnyRepoIndexing;

  // Graph poll interval: faster while indexing
  const graphPollInterval = isIndexing ? 5000 : 15000;

  async function loadAll() {
    try {
      // Settings is the auth gate. A 401 means the session cookie is stale or
      // expired — send the user to log in, NOT to the "no brain" key gate
      // (which would wrongly ask for the OpenRouter key even when it's set).
      const settingsResp = await fetch("/api/settings");
      if (settingsResp.status === 401) {
        window.location.href = "/login?from=%2F";
        return;
      }
      // 5xx means the orchestrator (Flow's engine) is down/unreachable — a
      // fixable ops condition, NOT "no key". Showing KeyGate here asks the
      // user for a key that can't save; say what's actually wrong instead.
      if (settingsResp.status >= 500) {
        setState("engine-down");
        return;
      }

      const [settingsRes, ingestRes, reposRes, auditRes, graphRes] = await Promise.allSettled([
        settingsResp.json() as Promise<SettingItem[]>,
        fetch("/api/ingest/status").then((r) => r.json()) as Promise<{ sources: IngestSource[] }>,
        fetch("/api/repos").then((r) => r.json()) as Promise<{ repos: RepoEntry[] }>,
        fetch("/api/audit?limit=20").then((r) => r.json()) as Promise<{ rows: AuditRow[] }>,
        fetch("/api/graph/overview").then((r) => r.json()) as Promise<{ nodes: unknown[]; edges: unknown[] }>,
      ]);

      const s = settingsRes.status === "fulfilled" ? (Array.isArray(settingsRes.value) ? settingsRes.value : []) : [];
      const ingest = ingestRes.status === "fulfilled" ? (ingestRes.value.sources ?? []) : [];
      const rps = reposRes.status === "fulfilled" ? (reposRes.value.repos ?? []) : [];
      const audit = auditRes.status === "fulfilled" ? (auditRes.value.rows ?? []) : [];
      const graph = graphRes.status === "fulfilled" ? graphRes.value : { nodes: [], edges: [] };

      setSettings(s);
      setSources(ingest);
      setRepos(rps);
      setAuditRows(audit);
      setGraphNodeCount((graph.nodes ?? []).length);
      setGraphEdgeCount((graph.edges ?? []).length);

      const brainSet = s.some((item) => item.key === "OPENROUTER_API_KEY" && item.set);
      if (!brainSet) {
        setState("no-brain");
        return;
      }

      const hasSources = rps.length > 0 || ingest.length > 0;
      const indexing = ingest.some((src) => src.catching_up) || rps.some((r) => !r.lastIndexedCommit);
      const hasContent = (graph.nodes ?? []).length > 0;

      if (!hasSources && !hasContent) {
        setState("empty");
      } else if (indexing && !hasContent) {
        setState("building");
      } else {
        setState("alive");
      }
    } catch {
      // Even the dashboard's own API didn't answer — engine/server trouble,
      // never a missing key. (KeyGate here was the old, misleading fallback.)
      setState("engine-down");
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While the engine is down, retry quietly — the moment `flow up` brings the
  // orchestrator back, the page heals itself without a manual refresh.
  useEffect(() => {
    if (state !== "engine-down") return;
    const iv = setInterval(() => {
      loadAll();
    }, 3000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Poll during building state
  useEffect(() => {
    if (state !== "building" && state !== "alive") return;
    const iv = setInterval(() => {
      // Re-check graph size for transitions
      fetch("/api/graph/overview")
        .then((r) => r.json())
        .then((d: { nodes: unknown[]; edges: unknown[] }) => {
          setGraphNodeCount((d.nodes ?? []).length);
          setGraphEdgeCount((d.edges ?? []).length);
          if ((d.nodes ?? []).length > 0 && state === "building") {
            setState("alive");
          }
        })
        .catch(() => {});
      // Also refresh ingest + repos
      fetch("/api/ingest/status")
        .then((r) => r.json())
        .then((d: { sources: IngestSource[] }) => setSources(d.sources ?? []))
        .catch(() => {});
      fetch("/api/repos")
        .then((r) => r.json())
        .then((d: { repos: RepoEntry[] }) => setRepos(d.repos ?? []))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, [state]);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (state === "loading") {
    return <div className="min-h-screen bg-cream" />;
  }

  // ── Engine down: the dashboard is fine but the orchestrator isn't answering.
  // Plain words + the exact command to run. Retries itself every 3s.
  if (state === "engine-down") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 bg-cream">
        <div className="w-full max-w-lg rise-in text-center">
          <div className="inline-block w-2.5 h-2.5 rounded-full bg-accent animate-pulse mb-6" />
          <h1 className="font-display text-[32px] leading-tight mb-3">
            Flow&apos;s engine isn&apos;t reachable.
          </h1>
          <p className="text-text-muted text-[15px] leading-relaxed mb-6">
            The dashboard is running, but this project&apos;s orchestrator isn&apos;t
            answering — it may still be starting up, or it stopped.
          </p>
          <div className="text-left inline-block bg-paper border border-line rounded-lg px-5 py-4 font-mono text-[13px] leading-loose">
            <div className="text-text-muted"># from your flow directory:</div>
            <div>flow doctor</div>
            <div className="text-text-muted"># or restart this project:</div>
            <div>flow up</div>
          </div>
          <p className="text-text-muted text-[13px] mt-6">
            This page checks again automatically — it&apos;ll come back on its own.
          </p>
        </div>
      </div>
    );
  }

  // ── State 0: No brain ──────────────────────────────────────────────────────
  if (state === "no-brain" || !hasBrain) {
    return <KeyGate onReady={() => { loadAll(); }} />;
  }

  // ── State 1: Empty brain ───────────────────────────────────────────────────
  if (state === "empty") {
    return (
      <Shell>
        <div className="max-w-2xl mx-auto py-8 rise-in">
          <div className="mb-10">
            <Kicker>Getting started</Kicker>
            <Heading as="h1" className="text-[36px] mt-3 mb-2">
              Your brain is empty.
            </Heading>
            <p className="text-text-muted text-[16px] leading-relaxed">
              Connect a source to start building your knowledge graph.
            </p>
          </div>

          <div className="grid gap-4">
            <GitHubCard onConnected={() => { loadAll(); setState("building"); }} />

            <ApiKeyCard
              icon={<BrandIcon name="linear" size={20} />}
              title="Linear"
              description="Sync your tickets and project context."
              settingKey="LINEAR_API_KEY"
              placeholder="lin_api_…"
              onConnected={() => { loadAll(); setState("building"); }}
            />

            <ApiKeyCard
              icon={<BrandIcon name="fireflies" size={20} />}
              title="Fireflies"
              description="Bring in meeting decisions and transcripts."
              settingKey="FIREFLIES_API_KEY"
              placeholder="ff_…"
              onConnected={() => { loadAll(); setState("building"); }}
            />

            <MeetingNotesCard onConnected={() => { loadAll(); setState("building"); }} />

            <SourceCard
              icon={<BrandIcon name="slack" size={20} />}
              title="Slack"
              description="Always-on ambient listening."
              locked
              lockReason="Available once deployed — requires a prod instance with a persistent connection."
            />
          </div>
        </div>
      </Shell>
    );
  }

  // ── State 2: Building ──────────────────────────────────────────────────────
  if (state === "building") {
    return (
      <Shell>
        <div className="flex flex-col gap-6 rise-in">
          {/* Header */}
          <div>
            <Kicker>Building your brain</Kicker>
            <Heading as="h1" className="text-[32px] mt-2">
              Reading your sources…
            </Heading>
            <p className="text-text-muted text-[15px] mt-1.5">
              New nodes are appearing as Flow reads and understands. Watch it grow.
            </p>
          </div>

          {/* Now-indexing panel */}
          <Card>
            <NowIndexingPanel />
          </Card>

          {/* Brain graph — polls during build — with indexing overlay */}
          <BrainGraph pollInterval={5000} height={380} isIndexing={true} />

          {/* Activity */}
          {auditRows.length > 0 && (
            <Card>
              <RecentActivity rows={auditRows} />
            </Card>
          )}
        </div>
      </Shell>
    );
  }

  // ── State 3: Alive ─────────────────────────────────────────────────────────

  return (
    <Shell>
      <div className="flex flex-col gap-8 rise-in">
        {/* Top stats bar */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <Kicker>{mode === "prod" ? "Production" : "Local mode"}</Kicker>
            <Heading as="h1" className="text-[30px] mt-2">
              {isIndexing ? "Flow is learning." : "Flow knows your stack."}
            </Heading>
          </div>
          <div className="flex items-center gap-3">
            {isIndexing && <StatusPill kind="live">Indexing</StatusPill>}
            <Button
              variant="primary"
              arrow
              onClick={() => router.push("/ask")}
            >
              Ask Flow
            </Button>
          </div>
        </div>

        {/* Brain stats */}
        {graphNodeCount > 0 && (
          <BrainStats
            nodeCount={graphNodeCount}
            edgeCount={graphEdgeCount}
            repoCount={repos.length || sources.length}
            sources={sources}
          />
        )}

        {/* Brain graph — hero — with indexing overlay when active */}
        <BrainGraph
          pollInterval={graphPollInterval}
          height={420}
          isIndexing={isIndexing}
        />

        {/* Now-indexing panel (if active) */}
        {isIndexing && (
          <Card>
            <NowIndexingPanel />
          </Card>
        )}

        {/* Sources management panel — ALL source management lives here */}
        <HomeSourcesPanel
          repos={repos}
          settings={settings}
          onSourceChanged={() => loadAll()}
        />

        {/* Recent activity */}
        {auditRows.length > 0 && (
          <RecentActivity rows={auditRows} />
        )}
      </div>
    </Shell>
  );
}

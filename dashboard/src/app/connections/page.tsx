"use client";
import { Shell } from "@/components/Shell";
import { AddSource } from "@/components/AddSource";
import { useState, FormEvent, useEffect, useCallback } from "react";
import { useMode } from "@/lib/useMode";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnStatus {
  linear_key: boolean;
  slack_bot_token: boolean;
  slack_app_token: boolean;
  fireflies_key: boolean;
  pending_repos: Array<{ url: string; branch: string; status: string; addedAt: string }>;
}

interface PendingRepo {
  url: string;
  branch: string;
  localClone: boolean;
  addedAt: string;
  status: string;
}

interface GhRepo {
  full_name: string;
  url: string;
  default_branch: string;
}

interface GhReposResponse {
  source: "gh_cli" | "pat" | "none";
  repos: GhRepo[];
  hint?: string;
}

interface IngestRow {
  source: string;
  resource: string;
  cursor: string;
  last_poll_at: number;
  lag_seconds: number | null;
  catching_up: boolean;
  status: string;
}

interface RepoEntry {
  name: string;
  url: string;
  branch: string;
}

interface ReposData {
  repos: RepoEntry[];
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "22px 24px",
        marginBottom: 20,
      }}
    >
      <h2
        style={{
          margin: "0 0 16px",
          fontSize: 14,
          fontWeight: 600,
          color: "var(--text-primary)",
          borderBottom: "1px solid var(--border)",
          paddingBottom: 12,
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: 12,
        fontWeight: 500,
        color: "var(--text-secondary)",
        marginBottom: 5,
      }}
    >
      {children}
    </label>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      style={{
        width: "100%",
        padding: "9px 11px",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: disabled ? "var(--surface-2)" : "var(--surface-2)",
        color: disabled ? "var(--text-muted)" : "var(--text-primary)",
        fontSize: 13,
        fontFamily: type === "password" ? "monospace" : "inherit",
        outline: "none",
        marginBottom: 12,
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "not-allowed" : "text",
        boxSizing: "border-box",
      }}
    />
  );
}

function StatusBadge({ on }: { on: boolean }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 4,
        background: on ? "rgba(34,197,94,0.1)" : "var(--surface-2)",
        color: on ? "var(--success)" : "var(--text-muted)",
        border: `1px solid ${on ? "rgba(34,197,94,0.2)" : "var(--border)"}`,
      }}
    >
      {on ? "Configured" : "Not set"}
    </span>
  );
}

function SubmitBtn({ loading, label, disabled = false }: { loading: boolean; label: string; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      style={{
        padding: "9px 18px",
        borderRadius: 6,
        border: "none",
        background: loading || disabled ? "var(--surface-2)" : "var(--accent)",
        color: loading || disabled ? "var(--text-muted)" : "#fff",
        fontSize: 13,
        fontWeight: 600,
        cursor: loading || disabled ? "not-allowed" : "pointer",
      }}
    >
      {loading ? "Saving..." : label}
    </button>
  );
}

// ─── Catching-Up Panel ────────────────────────────────────────────────────────

function CatchingUpPanel() {
  const [rows, setRows] = useState<IngestRow[]>([]);
  const [lastFetch, setLastFetch] = useState<number>(0);

  const fetchStatus = useCallback(() => {
    fetch("/api/ingest/status")
      .then((r) => r.json())
      .then((d) => {
        const data = d as { sources?: IngestRow[] };
        setRows(data.sources ?? []);
        setLastFetch(Date.now());
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 0" }}>
        No ingest sources active yet.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((row, i) => {
          const lagStr = row.lag_seconds === null
            ? "never polled"
            : row.lag_seconds > 60
            ? `${Math.round(row.lag_seconds / 60)}m lag`
            : `${row.lag_seconds}s lag`;

          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                background: "var(--surface-2)",
                borderRadius: 6,
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: row.catching_up ? "#f59e0b" : "#22c55e",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                  {row.source}
                </span>
                {row.resource && row.resource !== row.source && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>
                    {row.resource}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: row.catching_up ? "#f59e0b" : "var(--success)", fontWeight: 500 }}>
                {row.catching_up ? `catching up... (${lagStr})` : "up to date"}
              </div>
            </div>
          );
        })}
      </div>
      {lastFetch > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8 }}>
          Polled every 5s. Last update: {new Date(lastFetch).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

// ─── Repo Picker ──────────────────────────────────────────────────────────────

function RepoPicker({
  indexedUrls,
  onMsg,
}: {
  indexedUrls: Set<string>;
  onMsg: (s: string) => void;
}) {
  const [ghData, setGhData] = useState<GhReposResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [pat, setPat] = useState("");
  const [savingPat, setSavingPat] = useState(false);

  const loadRepos = useCallback(() => {
    setLoading(true);
    fetch("/api/github/repos")
      .then((r) => r.json())
      .then((d) => {
        setGhData(d as GhReposResponse);
        setLoading(false);
      })
      .catch(() => {
        setGhData({ source: "none", repos: [], hint: "Could not reach server." });
        setLoading(false);
      });
  }, []);

  useEffect(() => { loadRepos(); }, [loadRepos]);

  async function handleSavePat(e: FormEvent) {
    e.preventDefault();
    setSavingPat(true);
    try {
      await fetch("/api/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_pat", pat }),
      });
      setPat("");
      loadRepos();
    } catch {
      onMsg("Failed to save PAT.");
    } finally {
      setSavingPat(false);
    }
  }

  async function handleAddSelected() {
    if (selected.size === 0) return;
    setAdding(true);
    const reposToAdd = (ghData?.repos ?? [])
      .filter((r) => selected.has(r.full_name))
      .map((r) => ({
        ...r,
        branch: branches[r.full_name]?.trim() || r.default_branch,
      }));
    try {
      const res = await fetch("/api/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_repos", repos: reposToAdd }),
      });
      const data = await res.json() as { ok?: boolean; results?: Array<{ full_name: string; ok: boolean }> };
      const okCount = (data.results ?? []).filter((r) => r.ok).length;
      onMsg(`Added ${okCount} of ${reposToAdd.length} repo(s) to the registry. Reindex will be queued.`);
      setSelected(new Set());
    } catch {
      onMsg("Network error adding repos.");
    } finally {
      setAdding(false);
    }
  }

  const filtered = (ghData?.repos ?? []).filter((r) =>
    r.full_name.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading GitHub repos...</div>;
  }

  if (ghData?.source === "none") {
    return (
      <div>
        <div
          style={{
            padding: "14px 16px",
            background: "rgba(245,158,11,0.07)",
            border: "1px solid rgba(245,158,11,0.2)",
            borderRadius: 7,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#b45309", marginBottom: 4 }}>
            Connect GitHub to pick repos
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {ghData.hint ?? "Log in with `gh auth login` locally, or paste a fine-grained PAT below."}
          </div>
        </div>
        <form onSubmit={handleSavePat}>
          <Label>Fine-grained GitHub PAT (repo read access)</Label>
          <Input value={pat} onChange={setPat} placeholder="github_pat_..." type="password" />
          <SubmitBtn loading={savingPat} label="Connect with PAT" />
        </form>
      </div>
    );
  }

  return (
    <div>
      {/* Source badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 4,
            background: "rgba(34,197,94,0.1)",
            color: "var(--success)",
            border: "1px solid rgba(34,197,94,0.2)",
            fontWeight: 600,
          }}
        >
          {ghData?.source === "gh_cli" ? "gh CLI" : "GitHub PAT"}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {ghData?.repos.length ?? 0} repos available
        </span>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search repos..."
        style={{
          width: "100%",
          padding: "8px 11px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: "var(--text-primary)",
          fontSize: 13,
          outline: "none",
          marginBottom: 10,
          boxSizing: "border-box",
        }}
      />

      {/* Repo list */}
      <div
        style={{
          maxHeight: 280,
          overflowY: "auto",
          border: "1px solid var(--border)",
          borderRadius: 6,
          marginBottom: 12,
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: "16px", fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            No repos match your search.
          </div>
        ) : (
          filtered.map((repo) => {
            const isIndexed = indexedUrls.has(repo.url) || indexedUrls.has(repo.full_name);
            const isSelected = selected.has(repo.full_name);
            return (
              <label
                key={repo.full_name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  borderBottom: "1px solid var(--border)",
                  cursor: isIndexed ? "default" : "pointer",
                  background: isSelected ? "rgba(99,102,241,0.06)" : "transparent",
                  transition: "background 0.1s",
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected || isIndexed}
                  disabled={isIndexed}
                  onChange={() => {
                    if (isIndexed) return;
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(repo.full_name)) next.delete(repo.full_name);
                      else next.add(repo.full_name);
                      return next;
                    });
                  }}
                  style={{ width: 14, height: 14, accentColor: "var(--accent)", flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", fontFamily: "monospace" }}>
                    {repo.full_name}
                  </div>
                  {isSelected && !isIndexed ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)" }}>
                      branch:
                      <input
                        type="text"
                        value={branches[repo.full_name] ?? repo.default_branch}
                        onChange={(e) =>
                          setBranches((prev) => ({ ...prev, [repo.full_name]: e.target.value }))
                        }
                        onClick={(e) => e.preventDefault()}
                        spellCheck={false}
                        style={{
                          fontSize: 11,
                          fontFamily: "monospace",
                          padding: "1px 6px",
                          borderRadius: 4,
                          border: "1px solid var(--border)",
                          background: "var(--surface-2)",
                          color: "var(--text-primary)",
                          outline: "none",
                          width: 140,
                        }}
                      />
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      branch: {repo.default_branch}
                    </div>
                  )}
                </div>
                {isIndexed && (
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 7px",
                      borderRadius: 4,
                      background: "rgba(34,197,94,0.1)",
                      color: "var(--success)",
                      border: "1px solid rgba(34,197,94,0.2)",
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    indexed
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>

      {/* Add button */}
      <button
        onClick={handleAddSelected}
        disabled={selected.size === 0 || adding}
        style={{
          padding: "9px 18px",
          borderRadius: 6,
          border: "none",
          background: selected.size === 0 || adding ? "var(--surface-2)" : "var(--accent)",
          color: selected.size === 0 || adding ? "var(--text-muted)" : "#fff",
          fontSize: 13,
          fontWeight: 600,
          cursor: selected.size === 0 || adding ? "not-allowed" : "pointer",
        }}
      >
        {adding ? "Adding..." : `Add ${selected.size > 0 ? `${selected.size} ` : ""}Repo${selected.size !== 1 ? "s" : ""}`}
      </button>

      {/* GitHub App stub */}
      <div
        style={{
          marginTop: 16,
          padding: "12px 14px",
          background: "var(--surface-2)",
          border: "1px dashed var(--border)",
          borderRadius: 7,
          opacity: 0.7,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 2 }}>
          GitHub App (coming soon)
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Connect via GitHub App for managed deploys — fine-grained permissions, org-wide access.
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ConnectionsPage() {
  const { mode, loading: modeLoading } = useMode();
  const [status, setStatus] = useState<ConnStatus | null>(null);
  const [indexedRepos, setIndexedRepos] = useState<RepoEntry[]>([]);
  const [msg, setMsg] = useState("");

  // Meeting notes
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingText, setMeetingText] = useState("");
  const [meetingLoading, setMeetingLoading] = useState(false);

  const refresh = useCallback(() => {
    fetch("/api/connections")
      .then((r) => r.json())
      .then((d) => setStatus(d as ConnStatus))
      .catch(() => {});
    fetch("/api/repos")
      .then((r) => r.json())
      .then((d) => setIndexedRepos((d as ReposData).repos ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const indexedUrls = new Set([
    ...indexedRepos.map((r) => r.url),
    ...indexedRepos.map((r) => r.name),
  ]);

  async function handleMeeting(e: FormEvent) {
    e.preventDefault();
    setMeetingLoading(true);
    setMsg("");
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "meeting_notes", title: meetingTitle, text: meetingText }),
      });
      if (res.ok) {
        setMsg("Meeting notes ingested and sent to the orchestrator pipeline.");
        setMeetingTitle(""); setMeetingText("");
      } else {
        const d = await res.json() as Record<string, unknown>;
        setMsg((d.error as string) ?? "Error");
      }
    } catch {
      setMsg("Network error");
    } finally {
      setMeetingLoading(false);
    }
  }

  const isLocalMode = !modeLoading && mode === "local";

  return (
    <Shell>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
          Connections
        </h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
          Configure repos, integrations, and meeting notes.
        </p>
      </div>

      {msg && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 7,
            background: "rgba(99,102,241,0.08)",
            border: "1px solid rgba(99,102,241,0.2)",
            color: "var(--accent-hover)",
            fontSize: 12,
            marginBottom: 18,
          }}
        >
          {msg}
        </div>
      )}

      {/* ── Ingest Status Panel ───────────────────────────────────────────── */}
      <Section title="Ingest Status">
        <CatchingUpPanel />
      </Section>

      {/* ── Add a source (front door) ─────────────────────────────────────── */}
      <Section title="Add a source">
        <AddSource mode={mode} onAdded={refresh} />
      </Section>

      {/* ── Repo Picker ───────────────────────────────────────────────────── */}
      <Section title="Add Repositories">
        <RepoPicker indexedUrls={indexedUrls} onMsg={setMsg} />
      </Section>

      {/* ── Integration Connections ───────────────────────────────────────── */}
      <Section title="Integration Connections">
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>

          {/* Linear card — active in both modes */}
          <div
            style={{
              padding: "14px 16px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Linear</span>
              <StatusBadge on={!!status?.linear_key} />
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Polls for ticket updates. Works in local and prod modes.
            </div>
          </div>

          {/* GitHub card — active in both modes */}
          <div
            style={{
              padding: "14px 16px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>GitHub</span>
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "rgba(34,197,94,0.1)",
                  color: "var(--success)",
                  border: "1px solid rgba(34,197,94,0.2)",
                  fontWeight: 600,
                }}
              >
                Active
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Polls repos via gh CLI or PAT. Works in local and prod modes.
            </div>
          </div>

          {/* Fireflies card — active in both modes */}
          <div
            style={{
              padding: "14px 16px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Fireflies</span>
              <StatusBadge on={!!status?.fireflies_key} />
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Meeting transcript ingestion. Works in local and prod modes.
            </div>
          </div>

          {/* Slack card — mode gated */}
          {isLocalMode ? (
            <div
              style={{
                padding: "14px 16px",
                background: "rgba(0,0,0,0.02)",
                border: "1px dashed var(--border)",
                borderRadius: 8,
                opacity: 0.75,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)" }}>Slack</span>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: "var(--surface-2)",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border)",
                    fontWeight: 600,
                  }}
                >
                  LOCKED
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                Always-on only — Slack requires a deployed (prod) instance. Deploy to enable.
              </div>
            </div>
          ) : (
            <div
              style={{
                padding: "14px 16px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Slack</span>
                <StatusBadge on={!!(status?.slack_bot_token && status?.slack_app_token)} />
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Socket Mode bot for ambient listening. Tokens are managed in Settings.
              </div>
            </div>
          )}
        </div>

        {/* Keys now live in Settings */}
        <div
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: 16,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ flex: 1, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            Integration keys (Linear, Fireflies, GitHub PAT, Slack tokens) are now managed in{" "}
            <strong style={{ color: "var(--text-secondary)" }}>Settings</strong>. Changes are
            stored as orchestrator overrides and take effect immediately.
          </div>
          <a
            href="/settings"
            style={{
              padding: "8px 18px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              color: "var(--text-primary)",
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            Go to Settings
          </a>
        </div>
      </Section>

      {/* ── Manual Meeting Notes ──────────────────────────────────────────── */}
      <Section title="Manual Meeting Notes">
        <form onSubmit={handleMeeting}>
          <Label>Title (optional)</Label>
          <Input value={meetingTitle} onChange={setMeetingTitle} placeholder="Q2 planning call" />
          <Label>Meeting Notes / Transcript</Label>
          <textarea
            value={meetingText}
            onChange={(e) => setMeetingText(e.target.value)}
            placeholder="Paste transcript or notes here..."
            rows={8}
            style={{
              width: "100%",
              padding: "9px 11px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              color: "var(--text-primary)",
              fontSize: 12,
              fontFamily: "ui-monospace, monospace",
              outline: "none",
              resize: "vertical",
              marginBottom: 12,
              boxSizing: "border-box",
            }}
          />
          <SubmitBtn loading={meetingLoading} label="Ingest Notes" />
        </form>
      </Section>
    </Shell>
  );
}

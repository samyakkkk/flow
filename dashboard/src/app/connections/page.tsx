"use client";
import { Shell } from "@/components/Shell";
import { AddFolder } from "@/components/AddFolder";
import { AddRepoUrl } from "@/components/AddRepoUrl";
import { RepoPicker } from "@/components/RepoPicker";
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ConnectionsPage() {
  const { mode, loading: modeLoading } = useMode();
  const [status, setStatus] = useState<ConnStatus | null>(null);
  const [indexedRepos, setIndexedRepos] = useState<RepoEntry[]>([]);
  const [msg, setMsg] = useState("");
  const [showUrl, setShowUrl] = useState(false);

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

      {/* ── Add a folder — the folder door. Local mode only: on a remote Flow
          there's no filesystem to point at, so this collapses to GitHub. ── */}
      {isLocalMode && (
        <Section title="Add a folder">
          <AddFolder mode={mode} onAdded={refresh} hideLabel />
        </Section>
      )}

      {/* ── GitHub repos — the GitHub door: pick from the account's repo list.
          Pasting a repo URL is the small affordance at the bottom. ── */}
      <Section title="GitHub repos">
        <RepoPicker indexedUrls={indexedUrls} onMsg={setMsg} onConnected={refresh} />
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          {showUrl ? (
            <>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                Paste a repo URL
              </div>
              <AddRepoUrl onAdded={refresh} />
              <button
                onClick={() => setShowUrl(false)}
                style={{
                  marginTop: 10,
                  fontSize: 11,
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                }}
              >
                close
              </button>
            </>
          ) : (
            <button
              onClick={() => setShowUrl(true)}
              style={{
                fontSize: 12,
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                padding: 0,
                textDecoration: "underline",
              }}
            >
              or paste a repo URL
            </button>
          )}
        </div>
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

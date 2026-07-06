"use client";
import { Shell } from "@/components/Shell";
import { useEffect, useState, useCallback } from "react";

interface RepoEntry {
  name: string;
  url: string;
  branch: string;
  lastIndexedCommit?: string;
  addedAt: string;
  lastIndexedAt?: string;
}

interface ReposData {
  repos: RepoEntry[];
}

function timeAgo(iso?: string) {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "Just now";
}

function CommitHash({ hash }: { hash?: string }) {
  if (!hash) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  return (
    <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)" }}>
      {hash.slice(0, 8)}
    </span>
  );
}

export default function ReposPage() {
  const [data, setData] = useState<ReposData | null>(null);
  const [loading, setLoading] = useState(true);
  const [reindexMsgs, setReindexMsgs] = useState<Record<string, string>>({});
  const [reindexLoading, setReindexLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    fetch("/api/repos")
      .then((r) => r.json())
      .then((d) => {
        setData(d as ReposData);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleReindex(name: string) {
    setReindexLoading((l) => ({ ...l, [name]: true }));
    setReindexMsgs((m) => ({ ...m, [name]: "" }));
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reindex", repoName: name }),
      });
      const d = await res.json() as Record<string, unknown>;
      if (res.ok) {
        setReindexMsgs((m) => ({
          ...m,
          [name]: (d.note as string) ?? "Reindex job enqueued.",
        }));
      } else {
        setReindexMsgs((m) => ({ ...m, [name]: (d.error as string) ?? "Error" }));
      }
    } catch {
      setReindexMsgs((m) => ({ ...m, [name]: "Network error" }));
    } finally {
      setReindexLoading((l) => ({ ...l, [name]: false }));
    }
  }

  return (
    <Shell>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
          Repos
        </h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
          Registry from <code style={{ fontFamily: "monospace", fontSize: 11 }}>index-workspace/repos.json</code>.
          Reindex triggers an <code style={{ fontFamily: "monospace", fontSize: 11 }}>index_repo</code> job via the orchestrator.
        </p>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading repos...</div>
      ) : !data || data.repos.length === 0 ? (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "32px",
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 13,
          }}
        >
          No repos in registry yet. Add one from the Connections page.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {data.repos.map((repo) => (
            <div
              key={repo.name}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "20px 24px",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
                    {repo.name}
                  </div>
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 12,
                      color: "var(--accent-hover)",
                      textDecoration: "none",
                      fontFamily: "monospace",
                    }}
                  >
                    {repo.url}
                  </a>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  <button
                    onClick={() => handleReindex(repo.name)}
                    disabled={reindexLoading[repo.name]}
                    style={{
                      padding: "7px 16px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: reindexLoading[repo.name] ? "var(--surface-2)" : "var(--surface-2)",
                      color: reindexLoading[repo.name] ? "var(--text-muted)" : "var(--accent-hover)",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: reindexLoading[repo.name] ? "not-allowed" : "pointer",
                    }}
                  >
                    {reindexLoading[repo.name] ? "Queuing..." : "Reindex"}
                  </button>
                  {reindexMsgs[repo.name] && (
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", maxWidth: 260, textAlign: "right" }}>
                      {reindexMsgs[repo.name]}
                    </div>
                  )}
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                  gap: 12,
                }}
              >
                {[
                  { label: "Branch", value: repo.branch },
                  { label: "Last Indexed Commit", value: <CommitHash hash={repo.lastIndexedCommit} /> },
                  { label: "Added", value: timeAgo(repo.addedAt) },
                  { label: "Last Indexed", value: timeAgo(repo.lastIndexedAt) },
                ].map((item) => (
                  <div key={item.label}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      {item.label}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

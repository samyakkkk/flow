"use client";
// RepoPicker — the GitHub door: the checklist of the account's repositories,
// with per-repo base-branch inputs and PAT onboarding. Extracted from the
// Connections page so the home hero and Connections both mount the exact same
// component (behavior identical). onConnected is optional: Connections leaves
// it unset (message-only, as before); the home surfaces pass a refresh.
import { useState, FormEvent, useEffect, useCallback } from "react";
import { useProject } from "@/lib/useProject";
import { BranchSelect } from "@/components/BranchSelect";

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

// ─── Small form primitives (kept local so RepoPicker is self-contained) ───────

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

function PatInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%",
        padding: "9px 11px",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
        color: "var(--text-primary)",
        fontSize: 13,
        fontFamily: "monospace",
        outline: "none",
        marginBottom: 12,
        boxSizing: "border-box",
      }}
    />
  );
}

function SubmitBtn({ loading, label }: { loading: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={loading}
      style={{
        padding: "9px 18px",
        borderRadius: 6,
        border: "none",
        background: loading ? "var(--surface-2)" : "var(--accent)",
        color: loading ? "var(--text-muted)" : "#fff",
        fontSize: 13,
        fontWeight: 600,
        cursor: loading ? "not-allowed" : "pointer",
      }}
    >
      {loading ? "Saving..." : label}
    </button>
  );
}

// ─── RepoPicker ───────────────────────────────────────────────────────────────

export function RepoPicker({
  indexedUrls,
  onMsg,
  onConnected,
}: {
  indexedUrls: Set<string>;
  onMsg: (s: string) => void;
  onConnected?: () => void;
}) {
  const { prefix } = useProject();
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
    fetch(prefix("/api/github/repos"))
      .then((r) => r.json())
      .then((d) => {
        setGhData(d as GhReposResponse);
        setLoading(false);
      })
      .catch(() => {
        setGhData({ source: "none", repos: [], hint: "Could not reach server." });
        setLoading(false);
      });
  }, [prefix]);

  useEffect(() => { loadRepos(); }, [loadRepos]);

  async function handleSavePat(e: FormEvent) {
    e.preventDefault();
    setSavingPat(true);
    try {
      await fetch(prefix("/api/github/repos"), {
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
      const res = await fetch(prefix("/api/github/repos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_repos", repos: reposToAdd }),
      });
      const data = await res.json() as { ok?: boolean; results?: Array<{ full_name: string; ok: boolean }> };
      const okCount = (data.results ?? []).filter((r) => r.ok).length;
      onMsg(`Added ${okCount} of ${reposToAdd.length} repo(s) to the registry. Reindex will be queued.`);
      setSelected(new Set());
      onConnected?.();
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
          <PatInput value={pat} onChange={setPat} placeholder="github_pat_..." />
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
                    <div style={{ marginTop: 4 }} onClick={(e) => e.preventDefault()}>
                      <BranchSelect
                        repo={repo.url}
                        value={branches[repo.full_name] ?? repo.default_branch}
                        fallback={repo.default_branch}
                        onChange={(v) => setBranches((prev) => ({ ...prev, [repo.full_name]: v }))}
                        style={{
                          fontSize: 11,
                          padding: "2px 6px",
                          borderRadius: 4,
                          border: "1px solid var(--border)",
                          background: "var(--surface-2)",
                          color: "var(--text-primary)",
                          outline: "none",
                          cursor: "pointer",
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

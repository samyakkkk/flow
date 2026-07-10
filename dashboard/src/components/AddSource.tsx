"use client";
// AddSource — the "sources front door". One input accepts either a GitHub URL
// or a local filesystem path; the server classifies it and returns a verdict,
// which we render as a card with sensible, editable defaults. The user confirms
// and the source(s) register. Plain language only.
import { useState, useCallback, FormEvent } from "react";
import type { FlowMode } from "@/lib/useMode";

// ─── Contract types (mirror POST /v1/sources/inspect + /add) ─────────────────

type Kind =
  | "github_url"
  | "git_repo"
  | "git_repo_local_only"
  | "folder"
  | "container"
  | "unsupported";

interface GithubInfo {
  url: string;
  owner: string;
  name: string;
  defaultBranch: string;
  alreadyConnected: boolean;
}

interface RepoInfo {
  path: string;
  name: string;
  remoteUrl: string | null;
  defaultBranch: string;
  currentBranch: string;
  dirty: boolean;
  alreadyConnected: boolean;
}

interface SkippedCounts {
  hidden: number;
  deps: number;
  oversize: number;
  binary: number;
}

interface DocsInfo {
  path: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  skipped: SkippedCounts;
}

type ChildRepo = RepoInfo & { thirdParty: boolean; checkedDefault: boolean };

interface Children {
  repos: ChildRepo[];
  docs: DocsInfo;
}

interface Inspect {
  input: string;
  kind: Kind;
  github?: GithubInfo;
  repo?: RepoInfo;
  docs?: DocsInfo;
  children?: Children;
  error?: string;
}

type AddPayload =
  | { type: "repo"; url?: string | null; localPath?: string | null; branch: string; name: string }
  | { type: "docs"; path: string; name: string };

interface AddResult {
  added: Array<{ name: string; kind: string; jobId?: string }>;
  errors: Array<{ name: string; error: string }>;
}

// ─── Small shared styles (match the Connections page's inline language) ───────

const mono = { fontFamily: "var(--font-mono)" } as const;

function money(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(0)} KB`;
  return `${bytes} B`;
}

function branchInputStyle(): React.CSSProperties {
  return {
    ...mono,
    fontSize: 12,
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid var(--line)",
    background: "var(--cream)",
    color: "var(--ink)",
    outline: "none",
    width: 200,
    boxSizing: "border-box",
  };
}

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        ...mono,
        fontSize: 10.5,
        textTransform: "uppercase",
        letterSpacing: "0.10em",
        color: "var(--text-muted)",
      }}
    >
      {children}
    </span>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: "16px 18px",
        background: "var(--cream)",
        border: "1px solid var(--line)",
        borderRadius: 8,
      }}
    >
      {children}
    </div>
  );
}

function ConfirmBtn({
  loading,
  disabled,
  label,
  onClick,
}: {
  loading: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  const off = loading || disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      style={{
        padding: "8px 18px",
        borderRadius: 6,
        border: "none",
        background: off ? "var(--sand)" : "var(--accent)",
        color: off ? "var(--text-muted)" : "var(--ink)",
        fontSize: 13,
        fontWeight: 600,
        cursor: off ? "not-allowed" : "pointer",
      }}
    >
      {loading ? "Adding..." : label}
    </button>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddSource({
  mode,
  onAdded,
}: {
  mode: FlowMode;
  onAdded?: () => void;
}) {
  const isProd = mode === "prod";

  const [input, setInput] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState("");
  const [result, setResult] = useState<Inspect | null>(null);

  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [addResult, setAddResult] = useState<AddResult | null>(null);

  // Editable form state, initialized when a verdict arrives.
  const [branch, setBranch] = useState(""); // github_url / git_repo base branch
  const [childRepos, setChildRepos] = useState<
    Record<number, { checked: boolean; branch: string }>
  >({});
  const [docsChecked, setDocsChecked] = useState(true);
  const [showSkipped, setShowSkipped] = useState(false);

  // Seed the editable form state from a fresh verdict (done in the event
  // handler, not an effect, to avoid cascading renders).
  function seedForm(data: Inspect) {
    if (data.github) setBranch(data.github.defaultBranch);
    else if (data.repo) setBranch(data.repo.defaultBranch);
    else setBranch("");
    setShowSkipped(false);
    if (data.children) {
      const init: Record<number, { checked: boolean; branch: string }> = {};
      data.children.repos.forEach((r, i) => {
        init[i] = { checked: r.checkedDefault && !r.alreadyConnected, branch: r.defaultBranch };
      });
      setChildRepos(init);
      // "Everything else" docs row is checked by default in local mode.
      setDocsChecked(!isProd);
    } else {
      setChildRepos({});
      setDocsChecked(true);
    }
  }

  async function handleInspect(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || inspecting) return;
    setInspecting(true);
    setInspectError("");
    setResult(null);
    setAddResult(null);
    setAddError("");
    try {
      const res = await fetch("/api/sources/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });
      const data = (await res.json()) as Inspect;
      if (!res.ok || data.error) {
        // Surface the server's refusal verbatim (e.g. prod-mode path refusal).
        setInspectError(data.error ?? `Could not inspect (${res.status}).`);
        return;
      }
      seedForm(data);
      setResult(data);
    } catch {
      setInspectError("Network error — could not reach the server.");
    } finally {
      setInspecting(false);
    }
  }

  const submitAdd = useCallback(
    async (sources: AddPayload[]) => {
      if (sources.length === 0 || adding) return;
      setAdding(true);
      setAddError("");
      try {
        const res = await fetch("/api/sources/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sources }),
        });
        const data = (await res.json()) as AddResult & { error?: string };
        if (!res.ok) {
          setAddError(data.error ?? `Could not add (${res.status}).`);
          return;
        }
        setAddResult({ added: data.added ?? [], errors: data.errors ?? [] });
        setResult(null);
        setInput("");
        onAdded?.();
      } catch {
        setAddError("Network error — could not reach the server.");
      } finally {
        setAdding(false);
      }
    },
    [adding, onAdded]
  );

  // ─── Verdict renderers ──────────────────────────────────────────────────────

  function renderGithub(gh: GithubInfo) {
    return (
      <Card>
        <Kicker>Code · synced from GitHub</Kicker>
        <div style={{ ...mono, fontSize: 14, color: "var(--ink)", margin: "6px 0 10px" }}>
          {gh.owner}/{gh.name}
        </div>
        {gh.alreadyConnected ? (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            Already connected — nothing to do here.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 8 }}>
              Brain: mirrors{" "}
              <span style={{ ...mono, color: "var(--ink)" }}>{gh.defaultBranch}</span>
            </div>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
              Base branch
            </label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              spellCheck={false}
              style={branchInputStyle()}
            />
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>
              the branch Flow treats as reality — your changes are measured against it
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
              Flow will clone fresh.
            </div>
            <div style={{ marginTop: 14 }}>
              <ConfirmBtn
                loading={adding}
                disabled={!branch.trim()}
                label="Add source"
                onClick={() =>
                  submitAdd([
                    { type: "repo", url: gh.url, localPath: null, branch: branch.trim(), name: gh.name },
                  ])
                }
              />
            </div>
          </>
        )}
      </Card>
    );
  }

  function renderGitRepo(repo: RepoInfo) {
    return (
      <Card>
        <Kicker>Code · GitHub-synced, using your folder</Kicker>
        <div style={{ ...mono, fontSize: 14, color: "var(--ink)", margin: "6px 0 4px" }}>
          {repo.name}
        </div>
        <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
          {repo.path}
        </div>
        {repo.alreadyConnected ? (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            Already connected — nothing to do here.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 8 }}>
              Brain: mirrors{" "}
              <span style={{ ...mono, color: "var(--ink)" }}>{repo.defaultBranch}</span>
            </div>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
              Base branch
            </label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              spellCheck={false}
              style={branchInputStyle()}
            />
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>
              the branch Flow treats as reality — your changes are measured against it
            </div>
            <div style={{ fontSize: 13, color: "var(--text)", marginTop: 12 }}>
              Sessions run in your folder — it keeps your .env and installed dependencies.
            </div>
            {repo.dirty && (
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6 }}>
                uncommitted changes present — fine
              </div>
            )}
            <div style={{ marginTop: 14 }}>
              <ConfirmBtn
                loading={adding}
                disabled={!branch.trim()}
                label="Add source"
                onClick={() =>
                  submitAdd([
                    {
                      type: "repo",
                      url: repo.remoteUrl,
                      localPath: repo.path,
                      branch: branch.trim(),
                      name: repo.name,
                    },
                  ])
                }
              />
            </div>
          </>
        )}
      </Card>
    );
  }

  function renderLocalOnly(repo: RepoInfo) {
    return (
      <Card>
        <Kicker>Code · in your folder</Kicker>
        <div style={{ ...mono, fontSize: 14, color: "var(--ink)", margin: "6px 0 4px" }}>
          {repo.name}
        </div>
        <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
          {repo.path}
        </div>
        {repo.alreadyConnected ? (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            Already connected — nothing to do here.
          </div>
        ) : (
          <>
            <div
              style={{
                display: "inline-block",
                fontSize: 12,
                color: "var(--text)",
                background: "var(--sand)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                padding: "6px 10px",
                lineHeight: 1.5,
              }}
            >
              Local-only — the brain rescans on demand; push it to GitHub anytime to upgrade to
              auto-sync.
            </div>
            <div style={{ fontSize: 13, color: "var(--text)", marginTop: 10 }}>
              Base branch:{" "}
              <span style={{ ...mono, color: "var(--ink)" }}>{repo.currentBranch}</span>
            </div>
            <div style={{ marginTop: 14 }}>
              <ConfirmBtn
                loading={adding}
                label="Add source"
                onClick={() =>
                  submitAdd([
                    {
                      type: "repo",
                      url: null,
                      localPath: repo.path,
                      branch: repo.currentBranch,
                      name: repo.name,
                    },
                  ])
                }
              />
            </div>
          </>
        )}
      </Card>
    );
  }

  function renderSkipped(skipped: SkippedCounts) {
    const total = skipped.hidden + skipped.deps + skipped.oversize + skipped.binary;
    if (total === 0) return null;
    return (
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8 }}>
        Skipped: {total} file{total === 1 ? "" : "s"}{" "}
        <button
          type="button"
          onClick={() => setShowSkipped((s) => !s)}
          style={{
            ...mono,
            fontSize: 11,
            background: "none",
            border: "none",
            color: "var(--warn)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          [{showSkipped ? "hide" : "show"}]
        </button>
        {showSkipped && (
          <div style={{ marginTop: 4, paddingLeft: 10 }}>
            <div>hidden files: {skipped.hidden}</div>
            <div>dependencies: {skipped.deps}</div>
            <div>oversize: {skipped.oversize}</div>
            <div>binary: {skipped.binary}</div>
          </div>
        )}
      </div>
    );
  }

  function renderFolder(docs: DocsInfo) {
    return (
      <Card>
        <Kicker>Docs &amp; files — becomes searchable knowledge</Kicker>
        <div style={{ ...mono, fontSize: 14, color: "var(--ink)", margin: "6px 0 4px" }}>
          {docs.name}
        </div>
        <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
          {docs.path}
        </div>
        <div style={{ fontSize: 13, color: "var(--text)" }}>
          {docs.fileCount} file{docs.fileCount === 1 ? "" : "s"} · {money(docs.totalBytes)}
        </div>
        {renderSkipped(docs.skipped)}
        <div style={{ marginTop: 14 }}>
          <ConfirmBtn
            loading={adding}
            label="Add source"
            onClick={() => submitAdd([{ type: "docs", path: docs.path, name: docs.name }])}
          />
        </div>
      </Card>
    );
  }

  function renderContainer(children: Children) {
    const own = children.repos
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !r.thirdParty);
    const third = children.repos
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.thirdParty);

    const toggle = (i: number) =>
      setChildRepos((prev) => ({ ...prev, [i]: { ...prev[i], checked: !prev[i]?.checked } }));
    const setChildBranch = (i: number, v: string) =>
      setChildRepos((prev) => ({ ...prev, [i]: { ...prev[i], branch: v } }));

    const checkedCount =
      Object.values(childRepos).filter((c) => c.checked).length + (docsChecked ? 1 : 0);

    const repoRow = ({ r, i }: { r: ChildRepo; i: number }) => {
      const st = childRepos[i] ?? { checked: false, branch: r.defaultBranch };
      return (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 0",
            borderTop: "1px solid var(--line)",
          }}
        >
          <input
            type="checkbox"
            checked={st.checked}
            disabled={r.alreadyConnected}
            onChange={() => toggle(i)}
            style={{ width: 14, height: 14, accentColor: "var(--ink)", flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...mono, fontSize: 13, color: "var(--ink)" }}>{r.name}</div>
            {r.alreadyConnected && (
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>already connected</div>
            )}
          </div>
          <input
            value={st.branch}
            onChange={(e) => setChildBranch(i, e.target.value)}
            spellCheck={false}
            disabled={!st.checked}
            style={{ ...branchInputStyle(), width: 150, opacity: st.checked ? 1 : 0.5 }}
          />
        </div>
      );
    };

    return (
      <Card>
        <Kicker>A folder with several things inside</Kicker>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "6px 0 4px" }}>
          Pick what Flow should take on.
        </div>

        {/* Your repos */}
        {own.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", marginBottom: 2 }}>
              Your repos
            </div>
            {own.map(repoRow)}
          </div>
        )}

        {/* Third-party */}
        {third.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", cursor: "pointer" }}>
              Third-party ({third.length})
            </summary>
            <div style={{ marginTop: 6 }}>{third.map(repoRow)}</div>
          </details>
        )}

        {/* Everything else → docs */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 0",
            borderTop: "1px solid var(--line)",
            marginTop: 14,
          }}
        >
          <input
            type="checkbox"
            checked={docsChecked}
            onChange={() => setDocsChecked((c) => !c)}
            style={{ width: 14, height: 14, accentColor: "var(--ink)", flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500 }}>Everything else</div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
              everything except the repos above · {children.docs.fileCount} file
              {children.docs.fileCount === 1 ? "" : "s"} · {money(children.docs.totalBytes)}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <ConfirmBtn
            loading={adding}
            disabled={checkedCount === 0}
            label={`Add ${checkedCount} source${checkedCount === 1 ? "" : "s"}`}
            onClick={() => {
              const sources: AddPayload[] = [];
              children.repos.forEach((r, i) => {
                const st = childRepos[i];
                if (st?.checked) {
                  sources.push({
                    type: "repo",
                    url: r.remoteUrl,
                    localPath: r.path,
                    branch: (st.branch || r.defaultBranch).trim(),
                    name: r.name,
                  });
                }
              });
              if (docsChecked) {
                sources.push({
                  type: "docs",
                  path: children.docs.path,
                  name: children.docs.name,
                });
              }
              submitAdd(sources);
            }}
          />
        </div>
      </Card>
    );
  }

  function renderUnsupported(r: Inspect) {
    return (
      <Card>
        <Kicker>Not something Flow can take on</Kicker>
        <div style={{ fontSize: 13, color: "var(--text)", marginTop: 8, lineHeight: 1.5 }}>
          {r.error ??
            "Flow could not tell what this is. Try a GitHub repository URL, a local git repository, or a folder of documents."}
        </div>
      </Card>
    );
  }

  function renderVerdict(r: Inspect) {
    switch (r.kind) {
      case "github_url":
        return r.github ? renderGithub(r.github) : renderUnsupported(r);
      case "git_repo":
        return r.repo ? renderGitRepo(r.repo) : renderUnsupported(r);
      case "git_repo_local_only":
        return r.repo ? renderLocalOnly(r.repo) : renderUnsupported(r);
      case "folder":
        return r.docs ? renderFolder(r.docs) : renderUnsupported(r);
      case "container":
        return r.children ? renderContainer(r.children) : renderUnsupported(r);
      default:
        return renderUnsupported(r);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div>
      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {isProd
          ? "Paste a GitHub URL."
          : "Paste a GitHub URL or a local folder path — Flow figures out the rest."}
      </p>

      <form onSubmit={handleInspect} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isProd ? "https://github.com/owner/repo" : "https://github.com/owner/repo  or  /path/to/folder"}
          spellCheck={false}
          style={{
            ...mono,
            flex: 1,
            padding: "9px 11px",
            borderRadius: 6,
            border: "1px solid var(--line)",
            background: "var(--cream)",
            color: "var(--ink)",
            fontSize: 13,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <button
          type="submit"
          disabled={inspecting || !input.trim()}
          style={{
            padding: "9px 18px",
            borderRadius: 6,
            border: "1px solid var(--line)",
            background: inspecting || !input.trim() ? "var(--sand)" : "var(--paper)",
            color: inspecting || !input.trim() ? "var(--text-muted)" : "var(--ink)",
            fontSize: 13,
            fontWeight: 600,
            cursor: inspecting || !input.trim() ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {inspecting ? "Inspecting..." : "Inspect"}
        </button>
      </form>

      {isProd && (
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
          local paths live on your machine; on a remote Flow, connect GitHub repos or upload files
        </div>
      )}

      {inspectError && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderRadius: 6,
            background: "rgba(168,80,70,0.07)",
            border: "1px solid rgba(168,80,70,0.25)",
            color: "var(--danger)",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          {inspectError}
        </div>
      )}

      {result && renderVerdict(result)}

      {addError && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderRadius: 6,
            background: "rgba(168,80,70,0.07)",
            border: "1px solid rgba(168,80,70,0.25)",
            color: "var(--danger)",
            fontSize: 12.5,
          }}
        >
          {addError}
        </div>
      )}

      {addResult && (
        <div
          style={{
            marginTop: 14,
            padding: "12px 14px",
            borderRadius: 8,
            background: "rgba(90,140,90,0.08)",
            border: "1px solid rgba(90,140,90,0.22)",
          }}
        >
          {addResult.added.map((a, i) => (
            <div key={`ok-${i}`} style={{ fontSize: 12.5, color: "var(--text)" }}>
              <span style={{ ...mono, color: "var(--ink)" }}>{a.name}</span>
              {a.kind === "docs" ? " — added, ingestion coming soon" : " — indexing started"}
            </div>
          ))}
          {addResult.errors.map((e, i) => (
            <div key={`err-${i}`} style={{ fontSize: 12.5, color: "var(--danger)" }}>
              <span style={{ ...mono }}>{e.name}</span> — {e.error}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

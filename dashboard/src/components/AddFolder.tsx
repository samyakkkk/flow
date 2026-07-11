"use client";
// AddFolder — the folder door. The user browses their filesystem via a dialog
// to pick a project folder or folder of docs; the server classifies it and we
// show a second dialog to confirm with sensible, editable defaults. Branch
// selection is always a dropdown (fetched from the repo), never a text field.
import { useState } from "react";
import type { FlowMode } from "@/lib/useMode";
import { BranchSelect } from "@/components/BranchSelect";
import { FolderPickerDialog } from "@/components/FolderPickerDialog";
import {
  mono,
  money,
  ownerName,
  Kicker,
  ConfirmBtn,
  ErrorBox,
  AddResultBox,
  inspectInput,
  useSourceAdd,
  type Inspect,
  type RepoInfo,
  type DocsInfo,
  type SkippedCounts,
  type ChildRepo,
  type Children,
  type AddPayload,
  type AddResult,
} from "@/components/sources/kit";

// ─── Branch select style shared across verdict renderers ──────────────────────

const branchSelectStyle: React.CSSProperties = {
  padding: "5px 8px",
  borderRadius: 5,
  border: "1px solid var(--line)",
  background: "var(--cream)",
  color: "var(--ink)",
  fontSize: 12,
  width: "100%",
  outline: "none",
  boxSizing: "border-box",
  cursor: "pointer",
};

// ─── Source config modal (shown after a folder is inspected) ──────────────────

function SourceConfigModal({
  result,
  branch,
  setBranch,
  childRepos,
  setChildRepos,
  docsChecked,
  setDocsChecked,
  showSkipped,
  setShowSkipped,
  adding,
  addError,
  addResult,
  onAdd,
  onClose,
}: {
  result: Inspect;
  branch: string;
  setBranch: (v: string) => void;
  childRepos: Record<number, { checked: boolean; branch: string }>;
  setChildRepos: React.Dispatch<React.SetStateAction<Record<number, { checked: boolean; branch: string }>>>;
  docsChecked: boolean;
  setDocsChecked: React.Dispatch<React.SetStateAction<boolean>>;
  showSkipped: boolean;
  setShowSkipped: React.Dispatch<React.SetStateAction<boolean>>;
  adding: boolean;
  addError: string;
  addResult: AddResult | null;
  onAdd: (sources: AddPayload[]) => void;
  onClose: () => void;
}) {
  const toggle = (i: number) =>
    setChildRepos((prev) => ({ ...prev, [i]: { ...prev[i], checked: !prev[i]?.checked } }));
  const setChildBranch = (i: number, v: string) =>
    setChildRepos((prev) => ({ ...prev, [i]: { ...prev[i], branch: v } }));

  function renderSkipped(skipped: SkippedCounts) {
    const total = skipped.hidden + skipped.deps + skipped.oversize + skipped.binary;
    if (total === 0) return null;
    return (
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8 }}>
        Skipped: {total} file{total === 1 ? "" : "s"}{" "}
        <button
          type="button"
          onClick={() => setShowSkipped((s) => !s)}
          style={{ ...mono, fontSize: 11, background: "none", border: "none", color: "var(--warn)", cursor: "pointer", padding: 0 }}
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

  function renderGitRepo(repo: RepoInfo) {
    return (
      <>
        <Kicker>Code · GitHub-synced, using your folder</Kicker>
        <div style={{ ...mono, fontSize: 14, color: "var(--ink)", margin: "6px 0 4px" }}>{repo.name}</div>
        <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{repo.path}</div>
        {repo.remoteUrl && (
          <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>{ownerName(repo.remoteUrl)}</div>
        )}
        {repo.alreadyConnected ? (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Already connected — nothing to do here.</div>
        ) : (
          <>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
              Base branch
            </label>
            <BranchSelect
              repo={repo.remoteUrl ?? undefined}
              value={branch}
              fallback={repo.defaultBranch}
              onChange={setBranch}
              style={branchSelectStyle}
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
                  onAdd([{ type: "repo", url: repo.remoteUrl, localPath: repo.path, branch: branch.trim(), name: repo.name }])
                }
              />
            </div>
          </>
        )}
      </>
    );
  }

  function renderLocalOnly(repo: RepoInfo) {
    return (
      <>
        <Kicker>Code · in your folder</Kicker>
        <div style={{ ...mono, fontSize: 14, color: "var(--ink)", margin: "6px 0 4px" }}>{repo.name}</div>
        <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>{repo.path}</div>
        {repo.alreadyConnected ? (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Already connected — nothing to do here.</div>
        ) : (
          <>
            <div style={{ display: "inline-block", fontSize: 12, color: "var(--text)", background: "var(--sand)", border: "1px solid var(--line)", borderRadius: 6, padding: "6px 10px", lineHeight: 1.5 }}>
              Local-only — the brain rescans on demand; push it to GitHub anytime to upgrade to auto-sync.
            </div>
            <div style={{ fontSize: 13, color: "var(--text)", marginTop: 10 }}>
              Base branch: <span style={{ ...mono, color: "var(--ink)" }}>{repo.currentBranch}</span>
            </div>
            <div style={{ marginTop: 14 }}>
              <ConfirmBtn
                loading={adding}
                label="Add source"
                onClick={() =>
                  onAdd([{ type: "repo", url: null, localPath: repo.path, branch: repo.currentBranch, name: repo.name }])
                }
              />
            </div>
          </>
        )}
      </>
    );
  }

  function renderFolder(docs: DocsInfo) {
    return (
      <>
        <Kicker>Docs &amp; files — becomes searchable knowledge</Kicker>
        <div style={{ ...mono, fontSize: 14, color: "var(--ink)", margin: "6px 0 4px" }}>{docs.name}</div>
        <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>{docs.path}</div>
        <div style={{ fontSize: 13, color: "var(--text)" }}>
          {docs.fileCount} file{docs.fileCount === 1 ? "" : "s"} · {money(docs.totalBytes)}
        </div>
        {renderSkipped(docs.skipped)}
        <div style={{ marginTop: 14 }}>
          <ConfirmBtn
            loading={adding}
            label="Add source"
            onClick={() => onAdd([{ type: "docs", path: docs.path, name: docs.name }])}
          />
        </div>
      </>
    );
  }

  function renderContainer(children: Children) {
    const withGithub = children.repos.filter((r) => r.remoteUrl).length;
    const own = children.repos.map((r, i) => ({ r, i })).filter(({ r }) => !r.thirdParty);
    const third = children.repos.map((r, i) => ({ r, i })).filter(({ r }) => r.thirdParty);

    const checkedCount =
      Object.values(childRepos).filter((c) => c.checked).length + (docsChecked ? 1 : 0);

    const repoRow = ({ r, i }: { r: ChildRepo; i: number }) => {
      const st = childRepos[i] ?? { checked: false, branch: r.remoteUrl ? r.defaultBranch : r.currentBranch };
      return (
        <div
          key={i}
          style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderTop: "1px solid var(--line)" }}
        >
          <input
            type="checkbox"
            checked={st.checked}
            disabled={r.alreadyConnected}
            onChange={() => toggle(i)}
            style={{ width: 14, height: 14, accentColor: "var(--ink)", flexShrink: 0, marginTop: 2 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...mono, fontSize: 13, color: "var(--ink)" }}>{r.name}</div>
            {r.remoteUrl ? (
              <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: st.checked ? 6 : 0 }}>
                {ownerName(r.remoteUrl)}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: st.checked ? 6 : 0 }}>local-only</div>
            )}
            {r.alreadyConnected && (
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>already connected</div>
            )}
            {st.checked && !r.alreadyConnected && (
              r.remoteUrl ? (
                <BranchSelect
                  repo={r.remoteUrl}
                  value={st.branch}
                  fallback={r.defaultBranch}
                  onChange={(v) => setChildBranch(i, v)}
                  style={{ ...branchSelectStyle, width: "auto", minWidth: 160 }}
                />
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  branch: <span style={{ ...mono, color: "var(--ink)" }}>{r.currentBranch}</span>
                </div>
              )
            )}
          </div>
        </div>
      );
    };

    return (
      <>
        <Kicker>
          {withGithub > 0
            ? `Found ${withGithub} GitHub repo${withGithub === 1 ? "" : "s"} in this folder`
            : "A folder with several things inside"}
        </Kicker>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "6px 0 4px" }}>
          Pick what Flow should take on.
        </div>

        {own.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", marginBottom: 2 }}>Your repos</div>
            {own.map(repoRow)}
          </div>
        )}

        {third.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", cursor: "pointer" }}>
              Third-party ({third.length})
            </summary>
            <div style={{ marginTop: 6 }}>{third.map(repoRow)}</div>
          </details>
        )}

        {/* Everything else → docs */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid var(--line)", marginTop: 14 }}>
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
                    branch: (st.branch || r.defaultBranch || r.currentBranch).trim(),
                    name: r.name,
                  });
                }
              });
              if (docsChecked) {
                sources.push({ type: "docs", path: children.docs.path, name: children.docs.name });
              }
              onAdd(sources);
            }}
          />
        </div>
      </>
    );
  }

  function renderUnsupported(r: Inspect) {
    return (
      <>
        <Kicker>Not something Flow can take on</Kicker>
        <div style={{ fontSize: 13, color: "var(--text)", marginTop: 8, lineHeight: 1.5 }}>
          {r.error ?? "Flow could not tell what this is. Point it at a local git repository or a folder of documents."}
        </div>
      </>
    );
  }

  function renderVerdict(r: Inspect) {
    switch (r.kind) {
      case "git_repo":      return r.repo ? renderGitRepo(r.repo) : renderUnsupported(r);
      case "git_repo_local_only": return r.repo ? renderLocalOnly(r.repo) : renderUnsupported(r);
      case "folder":        return r.docs ? renderFolder(r.docs) : renderUnsupported(r);
      case "container":     return r.children ? renderContainer(r.children) : renderUnsupported(r);
      default:              return renderUnsupported(r);
    }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1001, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={addResult ? onClose : undefined}
    >
      <div
        style={{ background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 12, width: 520, maxHeight: "82vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            Configure sources
          </span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-muted)", lineHeight: 1, padding: "0 2px" }}
          >
            ×
          </button>
        </div>

        {/* Folder path */}
        <div style={{ padding: "8px 20px", borderBottom: "1px solid var(--line)", background: "var(--sand)" }}>
          <span style={{ ...mono, fontSize: 11, color: "var(--text-muted)" }}>{result.input}</span>
        </div>

        {/* Verdict body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {renderVerdict(result)}
          {addError && <ErrorBox message={addError} />}
          {addResult && <AddResultBox result={addResult} />}
        </div>
      </div>
    </div>
  );
}

// ─── AddFolder ────────────────────────────────────────────────────────────────

export function AddFolder({
  mode,
  onAdded,
  hideLabel = false,
}: {
  mode: FlowMode;
  onAdded?: () => void;
  hideLabel?: boolean;
}) {
  const isProd = mode === "prod";

  const [pickerOpen, setPickerOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState("");
  const [result, setResult] = useState<Inspect | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  const { adding, addError, addResult, submitAdd, clear } = useSourceAdd(onAdded);

  const [branch, setBranch] = useState("");
  const [childRepos, setChildRepos] = useState<Record<number, { checked: boolean; branch: string }>>({});
  const [docsChecked, setDocsChecked] = useState(true);
  const [showSkipped, setShowSkipped] = useState(false);

  function seedForm(data: Inspect) {
    if (data.repo) setBranch(data.repo.defaultBranch);
    else setBranch("");
    setShowSkipped(false);
    if (data.children) {
      const init: Record<number, { checked: boolean; branch: string }> = {};
      data.children.repos.forEach((r, i) => {
        const seedBranch = r.remoteUrl ? r.defaultBranch : r.currentBranch;
        init[i] = { checked: r.checkedDefault && !r.alreadyConnected, branch: seedBranch };
      });
      setChildRepos(init);
      setDocsChecked(!isProd);
    } else {
      setChildRepos({});
      setDocsChecked(true);
    }
  }

  async function handleFolderSelected(path: string) {
    setPickerOpen(false);
    setInspecting(true);
    setInspectError("");
    setResult(null);
    clear();
    const { data, error } = await inspectInput(path);
    setInspecting(false);
    if (error || !data) {
      setInspectError(error ?? "Could not inspect the folder.");
      return;
    }
    seedForm(data);
    setResult(data);
    setConfigOpen(true);
  }

  async function runAdd(sources: AddPayload[]) {
    const ok = await submitAdd(sources);
    if (ok) {
      setResult(null);
      setConfigOpen(false);
    }
  }

  return (
    <div>
      {!hideLabel && (
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 4 }}>
          Add a folder
        </label>
      )}
      <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Point Flow at a project folder or a folder of docs.
      </p>

      <button
        onClick={() => setPickerOpen(true)}
        disabled={inspecting}
        style={{
          padding: "9px 18px",
          borderRadius: 6,
          border: "1px solid var(--line)",
          background: inspecting ? "var(--sand)" : "var(--paper)",
          color: inspecting ? "var(--text-muted)" : "var(--ink)",
          fontSize: 13,
          fontWeight: 600,
          cursor: inspecting ? "not-allowed" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {inspecting ? "Inspecting..." : "Browse folders…"}
      </button>

      {inspectError && <ErrorBox message={inspectError} />}

      {pickerOpen && (
        <FolderPickerDialog
          onSelect={handleFolderSelected}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {configOpen && result && (
        <SourceConfigModal
          result={result}
          branch={branch}
          setBranch={setBranch}
          childRepos={childRepos}
          setChildRepos={setChildRepos}
          docsChecked={docsChecked}
          setDocsChecked={setDocsChecked}
          showSkipped={showSkipped}
          setShowSkipped={setShowSkipped}
          adding={adding}
          addError={addError}
          addResult={addResult}
          onAdd={runAdd}
          onClose={() => { setConfigOpen(false); setResult(null); clear(); }}
        />
      )}
    </div>
  );
}

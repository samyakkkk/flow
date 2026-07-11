"use client";
// AddFolder — the folder door. Point Flow at a project folder or a folder of
// docs; the server classifies the path and we render ONE confirm surface with
// sensible, editable defaults. If the folder turns out to hold GitHub repos we
// prefill each one's base branch and, on confirm, fold them into the GitHub
// option as normal GitHub-connected repos (with your folder as the work
// surface). Paths only — pasting a repo URL lives in the GitHub door.
import { useState, FormEvent } from "react";
import type { FlowMode } from "@/lib/useMode";
import {
  mono,
  money,
  branchInputStyle,
  ownerName,
  Kicker,
  Card,
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
} from "@/components/sources/kit";

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

  const [input, setInput] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState("");
  const [result, setResult] = useState<Inspect | null>(null);

  const { adding, addError, addResult, submitAdd, clear } = useSourceAdd(onAdded);

  // Editable form state, initialized when a verdict arrives.
  const [branch, setBranch] = useState(""); // single git_repo base branch
  const [childRepos, setChildRepos] = useState<
    Record<number, { checked: boolean; branch: string }>
  >({});
  const [docsChecked, setDocsChecked] = useState(true);
  const [showSkipped, setShowSkipped] = useState(false);

  // Seed the editable form state from a fresh verdict (in the event handler,
  // not an effect, to avoid cascading renders).
  function seedForm(data: Inspect) {
    if (data.repo) setBranch(data.repo.defaultBranch);
    else setBranch("");
    setShowSkipped(false);
    if (data.children) {
      const init: Record<number, { checked: boolean; branch: string }> = {};
      data.children.repos.forEach((r, i) => {
        // GitHub-backed repos track their default branch; local-only ones show
        // the branch you're on.
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

  async function handleInspect(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || inspecting) return;
    setInspecting(true);
    setInspectError("");
    setResult(null);
    clear();
    const { data, error } = await inspectInput(trimmed);
    if (error || !data) {
      setInspectError(error ?? "Could not inspect the folder.");
      setInspecting(false);
      return;
    }
    seedForm(data);
    setResult(data);
    setInspecting(false);
  }

  async function runAdd(sources: AddPayload[]) {
    const ok = await submitAdd(sources);
    if (ok) {
      setResult(null);
      setInput("");
    }
  }

  // ─── Verdict renderers ──────────────────────────────────────────────────────

  function renderGitRepo(repo: RepoInfo) {
    return (
      <Card>
        <Kicker>Code · GitHub-synced, using your folder</Kicker>
        <div style={{ ...mono, fontSize: 14, color: "var(--ink)", margin: "6px 0 4px" }}>
          {repo.name}
        </div>
        <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
          {repo.path}
        </div>
        {repo.remoteUrl && (
          <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
            {ownerName(repo.remoteUrl)}
          </div>
        )}
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
                  runAdd([
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
                  runAdd([
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
            onClick={() => runAdd([{ type: "docs", path: docs.path, name: docs.name }])}
          />
        </div>
      </Card>
    );
  }

  function renderContainer(children: Children) {
    const withGithub = children.repos.filter((r) => r.remoteUrl).length;

    const own = children.repos.map((r, i) => ({ r, i })).filter(({ r }) => !r.thirdParty);
    const third = children.repos.map((r, i) => ({ r, i })).filter(({ r }) => r.thirdParty);

    const toggle = (i: number) =>
      setChildRepos((prev) => ({ ...prev, [i]: { ...prev[i], checked: !prev[i]?.checked } }));
    const setChildBranch = (i: number, v: string) =>
      setChildRepos((prev) => ({ ...prev, [i]: { ...prev[i], branch: v } }));

    const checkedCount =
      Object.values(childRepos).filter((c) => c.checked).length + (docsChecked ? 1 : 0);

    const repoRow = ({ r, i }: { r: ChildRepo; i: number }) => {
      const st = childRepos[i] ?? { checked: false, branch: r.remoteUrl ? r.defaultBranch : r.currentBranch };
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
            {r.remoteUrl ? (
              <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)" }}>
                {ownerName(r.remoteUrl)}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>local-only</div>
            )}
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
        <Kicker>
          {withGithub > 0
            ? `Found ${withGithub} GitHub repo${withGithub === 1 ? "" : "s"} in this folder`
            : "A folder with several things inside"}
        </Kicker>
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
                    branch: (st.branch || r.defaultBranch || r.currentBranch).trim(),
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
              runAdd(sources);
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
            "Flow could not tell what this is. Point it at a local git repository or a folder of documents."}
        </div>
      </Card>
    );
  }

  function renderVerdict(r: Inspect) {
    switch (r.kind) {
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
      {/* Pages that wrap us in their own titled section pass hideLabel to
          avoid a stacked duplicate heading. */}
      {!hideLabel && (
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 4 }}>
          Add a folder
        </label>
      )}
      <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Point Flow at a project folder or a folder of docs.
      </p>

      <form onSubmit={handleInspect} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="/Users/you/projects/my-app"
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

      {inspectError && <ErrorBox message={inspectError} />}
      {result && renderVerdict(result)}
      {addError && <ErrorBox message={addError} />}
      {addResult && <AddResultBox result={addResult} />}
    </div>
  );
}

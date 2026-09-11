"use client";
// AddRepoUrl — the "or paste a repo URL" affordance that lives at the bottom of
// the GitHub door. A minimal URL input → the same inspect/add flow, rendering
// the github_url verdict with an editable base branch. This is the only place
// pasting a URL survives; folders go through AddFolder, and browsing your
// account goes through the RepoPicker checklist above.
import { useState, FormEvent } from "react";
import { useProject } from "@/lib/useProject";
import {
  mono,
  branchInputStyle,
  Kicker,
  Card,
  ConfirmBtn,
  ErrorBox,
  AddResultBox,
  inspectInput,
  useSourceAdd,
  type Inspect,
  type GithubInfo,
} from "@/components/sources/kit";

export function AddRepoUrl({ onAdded }: { onAdded?: () => void }) {
  const { prefix } = useProject();
  const [input, setInput] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState("");
  const [result, setResult] = useState<Inspect | null>(null);
  const [branch, setBranch] = useState("");

  const { adding, addError, addResult, submitAdd, clear } = useSourceAdd(onAdded);

  async function handleInspect(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || inspecting) return;
    setInspecting(true);
    setInspectError("");
    setResult(null);
    clear();
    const { data, error } = await inspectInput(trimmed, prefix);
    if (error || !data) {
      setInspectError(error ?? "Could not inspect that URL.");
      setInspecting(false);
      return;
    }
    if (data.github) setBranch(data.github.defaultBranch);
    setResult(data);
    setInspecting(false);
  }

  async function runAdd(gh: GithubInfo) {
    const ok = await submitAdd([
      { type: "repo", url: gh.url, localPath: null, branch: branch.trim(), name: gh.name },
    ]);
    if (ok) {
      setResult(null);
      setInput("");
    }
  }

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
                onClick={() => runAdd(gh)}
              />
            </div>
          </>
        )}
      </Card>
    );
  }

  function renderVerdict(r: Inspect) {
    if (r.kind === "github_url" && r.github) return renderGithub(r.github);
    return (
      <Card>
        <Kicker>Not a repo URL</Kicker>
        <div style={{ fontSize: 13, color: "var(--text)", marginTop: 8, lineHeight: 1.5 }}>
          {r.error ?? "That doesn't look like a GitHub repository URL. Try https://github.com/owner/repo."}
        </div>
      </Card>
    );
  }

  return (
    <div>
      <form onSubmit={handleInspect} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="https://github.com/owner/repo"
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

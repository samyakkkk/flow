"use client";
// Shared internals for the "add a source" doors. Both the folder door
// (AddFolder) and the GitHub URL-paste (AddRepoUrl) speak the same backend
// contract — POST /api/sources/inspect → a verdict, then POST /api/sources/add
// — so the contract types, the small styled bits, the error/success banners,
// and the add-submit logic live here once. Plain language only; never the
// words worktree / carve-out.
import { useCallback, useState } from "react";

// ─── Contract types (mirror POST /v1/sources/inspect + /add) ─────────────────

export type Kind =
  | "github_url"
  | "git_repo"
  | "git_repo_local_only"
  | "folder"
  | "container"
  | "unsupported";

export interface GithubInfo {
  url: string;
  owner: string;
  name: string;
  defaultBranch: string;
  alreadyConnected: boolean;
}

export interface RepoInfo {
  path: string;
  name: string;
  remoteUrl: string | null;
  defaultBranch: string;
  currentBranch: string;
  dirty: boolean;
  alreadyConnected: boolean;
}

export interface SkippedCounts {
  hidden: number;
  deps: number;
  oversize: number;
  binary: number;
}

export interface DocsInfo {
  path: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  skipped: SkippedCounts;
}

export type ChildRepo = RepoInfo & { thirdParty: boolean; checkedDefault: boolean };

export interface Children {
  repos: ChildRepo[];
  docs: DocsInfo;
}

export interface Inspect {
  input: string;
  kind: Kind;
  github?: GithubInfo;
  repo?: RepoInfo;
  docs?: DocsInfo;
  children?: Children;
  error?: string;
}

export type AddPayload =
  | { type: "repo"; url?: string | null; localPath?: string | null; branch: string; name: string }
  | { type: "docs"; path: string; name: string };

export interface AddResult {
  added: Array<{ name: string; kind: string; jobId?: string }>;
  errors: Array<{ name: string; error: string }>;
}

// ─── Small shared styles ──────────────────────────────────────────────────────

export const mono = { fontFamily: "var(--font-mono)" } as const;

export function money(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function branchInputStyle(): React.CSSProperties {
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

// Pull "owner/name" out of a git remote URL for muted display. Best-effort;
// falls back to the raw string when it doesn't look like a remote we know.
export function ownerName(remoteUrl: string): string {
  const m = remoteUrl.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : remoteUrl;
}

export function Kicker({ children }: { children: React.ReactNode }) {
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

export function Card({ children }: { children: React.ReactNode }) {
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

export function ConfirmBtn({
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

// ─── Banners (server copy verbatim; success list) ─────────────────────────────

export function ErrorBox({ message }: { message: string }) {
  return (
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
      {message}
    </div>
  );
}

export function AddResultBox({ result }: { result: AddResult }) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: "12px 14px",
        borderRadius: 8,
        background: "rgba(90,140,90,0.08)",
        border: "1px solid rgba(90,140,90,0.22)",
      }}
    >
      {result.added.map((a, i) => (
        <div key={`ok-${i}`} style={{ fontSize: 12.5, color: "var(--text)" }}>
          <span style={{ ...mono, color: "var(--ink)" }}>{a.name}</span>
          {a.kind === "docs" ? " — added, ingestion coming soon" : " — indexing started"}
        </div>
      ))}
      {result.errors.map((e, i) => (
        <div key={`err-${i}`} style={{ fontSize: 12.5, color: "var(--danger)" }}>
          <span style={{ ...mono }}>{e.name}</span> — {e.error}
        </div>
      ))}
    </div>
  );
}

// ─── inspect + add plumbing (shared by both doors) ────────────────────────────

// POST the raw input (a path or a URL) to the classifier. Surfaces the server's
// refusal verbatim (e.g. a prod-mode path refusal) rather than inventing copy.
export async function inspectInput(
  input: string
): Promise<{ data?: Inspect; error?: string }> {
  try {
    const res = await fetch("/api/sources/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const data = (await res.json()) as Inspect;
    if (!res.ok || data.error) {
      return { error: data.error ?? `Could not inspect (${res.status}).` };
    }
    return { data };
  } catch {
    return { error: "Network error — could not reach the server." };
  }
}

// Encapsulates the add-submit call plus its error / success banner state, so
// each door renders <AddResultBox> / <ErrorBox> without repeating the fetch.
export function useSourceAdd(onAdded?: () => void) {
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [addResult, setAddResult] = useState<AddResult | null>(null);

  const clear = useCallback(() => {
    setAddError("");
    setAddResult(null);
  }, []);

  const submitAdd = useCallback(
    async (sources: AddPayload[]): Promise<boolean> => {
      if (sources.length === 0 || adding) return false;
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
          return false;
        }
        setAddResult({ added: data.added ?? [], errors: data.errors ?? [] });
        onAdded?.();
        return true;
      } catch {
        setAddError("Network error — could not reach the server.");
        return false;
      } finally {
        setAdding(false);
      }
    },
    [adding, onAdded]
  );

  return { adding, addError, addResult, submitAdd, clear };
}

"use client";
// Renders a unified git diff with per-file grouping and add/remove coloring.
// Lightweight — no diff library; it just colorizes the lines git already
// produced. Each file is a collapsible section.
import { useMemo, useState } from "react";

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: "modified" | "added";
}

interface Hunk {
  path: string;
  status: string;
  lines: string[];
}

// Split a unified diff into per-file hunks keyed by the new path.
function splitByFile(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      if (cur) out.push(cur);
      // "diff --git a/foo b/foo" → take the b/ path
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : line.slice(11), status: "modified", lines: [] };
    } else if (cur) {
      if (line.startsWith("new file")) cur.status = "added";
      if (line.startsWith("deleted file")) cur.status = "deleted";
      cur.lines.push(line);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function lineColor(line: string): { color?: string; bg?: string; muted?: boolean } {
  if (line.startsWith("@@")) return { color: "var(--text-muted)", bg: "rgba(80,120,200,0.08)" };
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") || line.startsWith("diff ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename ")) {
    return { muted: true };
  }
  if (line.startsWith("+")) return { color: "rgb(60,120,70)", bg: "rgba(90,140,90,0.10)" };
  if (line.startsWith("-")) return { color: "rgb(168,80,70)", bg: "rgba(168,80,70,0.09)" };
  return {};
}

function FileHunk({ hunk }: { hunk: Hunk }) {
  const [open, setOpen] = useState(true);
  // Drop the redundant header lines already shown in the file title bar.
  const body = hunk.lines.filter(
    (l) =>
      !l.startsWith("index ") &&
      !l.startsWith("--- ") &&
      !l.startsWith("+++ ") &&
      !l.startsWith("new file") &&
      !l.startsWith("deleted file") &&
      !l.startsWith("similarity ") &&
      !l.startsWith("rename ")
  );
  return (
    <div className="rounded-md border border-line overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-cream text-left"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <span className="text-text-muted text-[10px]">{open ? "▾" : "▸"}</span>
        <span className="text-ink text-[11.5px] truncate flex-1">{hunk.path}</span>
        {hunk.status !== "modified" && (
          <span className="text-[9.5px] uppercase tracking-wider text-text-muted">{hunk.status}</span>
        )}
      </button>
      {open && (
        <div className="overflow-x-auto">
          <pre className="text-[11px] leading-[1.5]" style={{ fontFamily: "var(--font-mono)", margin: 0 }}>
            {body.map((line, i) => {
              const { color, bg, muted } = lineColor(line);
              return (
                <div
                  key={i}
                  style={{
                    color: muted ? "var(--text-muted)" : color ?? "var(--text)",
                    background: bg,
                    padding: "0 12px",
                    whiteSpace: "pre",
                    opacity: muted ? 0.6 : 1,
                  }}
                >
                  {line || " "}
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}

export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const hunks = useMemo(() => splitByFile(diff), [diff]);
  if (hunks.length === 0) {
    return <p className="text-text-muted text-[12px] px-1 py-2">No file changes yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {hunks.map((h, i) => (
        <FileHunk key={`${h.path}-${i}`} hunk={h} />
      ))}
      {truncated && (
        <p className="text-text-muted text-[11px] px-1" style={{ fontFamily: "var(--font-mono)" }}>
          diff truncated — open the folder to see the rest
        </p>
      )}
    </div>
  );
}

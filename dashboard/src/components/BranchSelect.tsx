"use client";

import { useEffect, useMemo, useState } from "react";

interface BranchSelectProps {
  // Pass `repo` (registry name or remote URL) to fetch from the orchestrator.
  // Pass `localPath` (absolute FS path) to fetch directly from the filesystem —
  // used when a repo isn't registered yet (add-folder flow).
  // When both are provided, localPath takes precedence.
  repo?: string;
  localPath?: string;
  value: string;
  fallback: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onChange: (value: string) => void;
}

export function BranchSelect({ repo, localPath, value, fallback, disabled, className, style, onChange }: BranchSelectProps) {
  const [branches, setBranches] = useState<string[]>(fallback ? [fallback] : []);

  useEffect(() => {
    let cancelled = false;
    const base = fallback || value;
    setBranches(base ? [base] : []);

    if (localPath) {
      fetch(`/api/fs/branches?path=${encodeURIComponent(localPath)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { branches?: unknown } | null) => {
          if (cancelled || !Array.isArray(data?.branches)) return;
          const next = data.branches.map(String).filter(Boolean);
          if (next.length > 0) setBranches(next);
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }

    if (!repo) return;
    fetch(`/api/agents/repos/branches?repo=${encodeURIComponent(repo)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { branches?: unknown } | null) => {
        if (cancelled || !Array.isArray(data?.branches)) return;
        const next = data.branches.map(String).filter(Boolean);
        if (next.length > 0) setBranches(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fallback, repo, localPath]);

  const options = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const branch of [value, fallback, ...branches]) {
      const normalized = branch.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }, [branches, fallback, value]);

  return (
    <select
      value={value || fallback}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className}
      style={{ fontFamily: "var(--font-mono)", ...style }}
    >
      {options.map((branch) => (
        <option key={branch} value={branch}>
          {branch}
        </option>
      ))}
    </select>
  );
}

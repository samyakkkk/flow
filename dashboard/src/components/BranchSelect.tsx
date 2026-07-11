"use client";

import { useEffect, useMemo, useState } from "react";

interface BranchSelectProps {
  repo?: string;
  value: string;
  fallback: string;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}

export function BranchSelect({ repo, value, fallback, disabled, className, onChange }: BranchSelectProps) {
  const [branches, setBranches] = useState<string[]>(fallback ? [fallback] : []);

  useEffect(() => {
    let cancelled = false;
    const base = fallback || value;
    setBranches(base ? [base] : []);
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
  }, [fallback, repo]);

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
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {options.map((branch) => (
        <option key={branch} value={branch}>
          {branch}
        </option>
      ))}
    </select>
  );
}

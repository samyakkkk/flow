"use client";

import { useState, useEffect, useCallback } from "react";
import { useProject } from "@/lib/useProject";

interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface BrowseData {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

const mono = { fontFamily: "var(--font-mono, monospace)" } as const;

export function FolderPickerDialog({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { prefix } = useProject();
  const [data, setData] = useState<BrowseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const navigate = useCallback(async (path: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(prefix(`/api/fs/browse?path=${encodeURIComponent(path)}`));
      const json = await res.json() as BrowseData & { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Could not open folder.");
      } else {
        setData(json);
      }
    } catch {
      setError("Network error browsing filesystem.");
    }
    setLoading(false);
  }, [prefix]);

  useEffect(() => { navigate("~"); }, [navigate]);

  // Build breadcrumb segments from current path
  const segments = data?.path.split("/").filter(Boolean) ?? [];

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 12, width: 580, maxHeight: "78vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>Choose a folder</span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-muted)", lineHeight: 1, padding: "0 2px" }}
          >
            ×
          </button>
        </div>

        {/* Breadcrumb */}
        <div style={{ padding: "8px 20px", borderBottom: "1px solid var(--line)", display: "flex", flexWrap: "wrap", gap: 0, alignItems: "center", minHeight: 36 }}>
          <button
            onClick={() => navigate("/")}
            style={{ ...mono, background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "2px 4px", fontSize: 12 }}
          >
            /
          </button>
          {segments.map((seg, i) => {
            const segPath = "/" + segments.slice(0, i + 1).join("/");
            const isLast = i === segments.length - 1;
            return (
              <span key={segPath} style={{ display: "flex", alignItems: "center" }}>
                <button
                  onClick={() => !isLast && navigate(segPath)}
                  style={{
                    ...mono,
                    background: "none",
                    border: "none",
                    cursor: isLast ? "default" : "pointer",
                    color: isLast ? "var(--ink)" : "var(--text-muted)",
                    padding: "2px 4px",
                    fontSize: 12,
                    fontWeight: isLast ? 600 : 400,
                  }}
                >
                  {seg}
                </button>
                {!isLast && (
                  <span style={{ ...mono, fontSize: 12, color: "var(--text-muted)", userSelect: "none" }}>/</span>
                )}
              </span>
            );
          })}
        </div>

        {/* Entry list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading ? (
            <div style={{ padding: 24, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
              Loading...
            </div>
          ) : error ? (
            <div style={{ padding: 20, fontSize: 12, color: "var(--warn)" }}>{error}</div>
          ) : (
            <>
              {data?.parent && (
                <button
                  onClick={() => navigate(data.parent!)}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 20px", background: "none", border: "none", borderBottom: "1px solid var(--line)", cursor: "pointer", fontSize: 13, color: "var(--text-muted)", textAlign: "left" }}
                >
                  <span style={{ fontSize: 11, width: 16, textAlign: "center", flexShrink: 0, opacity: 0.6 }}>↑</span>
                  <span style={{ ...mono, fontSize: 12 }}>..</span>
                </button>
              )}
              {(data?.entries ?? []).length === 0 && (
                <div style={{ padding: 24, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
                  Empty folder
                </div>
              )}
              {(data?.entries ?? []).map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => entry.isDir ? navigate(entry.path) : undefined}
                  disabled={!entry.isDir}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    padding: "8px 20px",
                    background: "none",
                    border: "none",
                    borderBottom: "1px solid var(--line)",
                    cursor: entry.isDir ? "pointer" : "default",
                    fontSize: 13,
                    color: entry.isDir ? "var(--ink)" : "var(--text-muted)",
                    textAlign: "left",
                  }}
                >
                  {/* Dir/file indicator */}
                  <span
                    style={{
                      fontSize: 10,
                      width: 16,
                      textAlign: "center",
                      flexShrink: 0,
                      color: entry.isDir ? "var(--text-muted)" : "var(--text-muted)",
                      opacity: entry.isDir ? 0.7 : 0.4,
                    }}
                  >
                    {entry.isDir ? "▸" : "·"}
                  </span>
                  <span style={{ ...mono, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.name}
                  </span>
                  {entry.isDir && (
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", opacity: 0.5, flexShrink: 0 }}>
                      →
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{ padding: "12px 20px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "var(--sand)" }}
        >
          <span style={{ ...mono, fontSize: 11, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data?.path ?? ""}
          </span>
          <button
            onClick={() => data && onSelect(data.path)}
            disabled={!data}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "1px solid var(--line)",
              background: data ? "var(--ink)" : "var(--sand)",
              color: data ? "var(--paper)" : "var(--text-muted)",
              fontSize: 13,
              fontWeight: 600,
              cursor: data ? "pointer" : "not-allowed",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";
// ProjectSwitcher — the door between projects. Lists what this session may
// see (/api/projects is grant-filtered in prod) and navigates to the picked
// project's home. Rendered in the nav even with one project, so the project
// you're in is always visible and the mechanism is discoverable.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/useProject";

interface ProjectEntry {
  name: string;
  mode: string;
}

export function ProjectSwitcher() {
  const { project } = useProject();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/projects", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => setProjects((d as { projects?: ProjectEntry[] }).projects ?? []))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!project) return null;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg transition-colors"
        style={{
          background: "var(--sand)",
          border: "1px solid var(--line)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span className="flex flex-col" style={{ minWidth: 0 }}>
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="text-[9px] uppercase tracking-widest text-text-muted"
          >
            Project
          </span>
          <span
            style={{ fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 500, color: "var(--ink)" }}
            className="truncate"
          >
            {project}
          </span>
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden style={{ flexShrink: 0, opacity: 0.5 }}>
          <path d="M2 3.5L5 6.5L8 3.5" stroke="var(--ink)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && projects.length > 0 && (
        <div
          role="listbox"
          className="absolute left-0 right-0 mt-1 rounded-lg overflow-hidden"
          style={{
            background: "var(--paper)",
            border: "1px solid var(--line)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
            zIndex: 50,
          }}
        >
          {projects.map((p) => (
            <button
              key={p.name}
              type="button"
              role="option"
              aria-selected={p.name === project}
              onClick={() => {
                setOpen(false);
                if (p.name !== project) router.push(`/p/${p.name}/`);
              }}
              className="w-full flex items-center justify-between px-3 py-2 transition-colors hover:bg-sand"
              style={{
                background: p.name === project ? "var(--sand)" : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span
                style={{ fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink)" }}
                className="truncate"
              >
                {p.name}
              </span>
              <span
                style={{ fontFamily: "var(--font-mono)" }}
                className="text-[9px] uppercase tracking-widest text-text-muted"
              >
                {p.mode === "prod" ? "prod" : "local"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

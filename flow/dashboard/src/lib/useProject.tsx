"use client";
// Client-side project scope, derived from the URL's first path segment
// (/<project>/...). Deriving from usePathname() — not from a server-rendered
// prop — matters: the root layout doesn't re-render on client navigation
// between projects (both URLs rewrite to the same internal route), so a
// server-provided value would go stale after a switch.
//
// Every client component builds project-scoped URLs through prefix():
//
//   fetch(prefix("/api/settings"))        → /<name>/api/settings
//   router.push(prefix("/agents/123"))    → /<name>/agents/123
//   <Link href={prefix("/activity")}>     → /<name>/activity
//
// The provider also keys its subtree by project, so switching projects
// REMOUNTS the page — mount-effects re-fetch against the new project instead
// of showing the previous project's data until a hard reload.
//
// Deployment-level pages (login) have no project; prefix() is the identity
// there, so shared components degrade instead of crashing.
import { createContext, useContext, Fragment, type ReactNode } from "react";
import { usePathname } from "next/navigation";

// First segments that are NOT project names. Mirrors proxy.ts.
const RESERVED = new Set(["login", "api", "_next", "favicon.ico", "p"]);

export function projectFromPathname(pathname: string | null): string | null {
  const seg = (pathname ?? "").split("/")[1] ?? "";
  if (!seg || RESERVED.has(seg) || !/^[a-zA-Z0-9_-]+$/.test(seg)) return null;
  return seg;
}

interface ProjectContextValue {
  /** Current project name, or null on deployment-level pages. */
  project: string | null;
  /** Prefix an app-absolute path ("/api/x", "/agents/1") with /<name>. */
  prefix: (path: string) => string;
}

const ProjectContext = createContext<ProjectContextValue>({
  project: null,
  prefix: (path) => path,
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const project = projectFromPathname(pathname);
  const value: ProjectContextValue = {
    project,
    prefix: project ? (path) => `/${project}${path}` : (path) => path,
  };
  return (
    <ProjectContext.Provider value={value}>
      <Fragment key={project ?? "@none"}>{children}</Fragment>
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  return useContext(ProjectContext);
}

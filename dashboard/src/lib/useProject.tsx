"use client";
// Client-side project scope. The root layout reads the project name the proxy
// stamped on the request and mounts this provider; every client component
// then builds project-scoped URLs through prefix():
//
//   fetch(prefix("/api/settings"))        → /p/<name>/api/settings
//   router.push(prefix("/agents/123"))    → /p/<name>/agents/123
//   <Link href={prefix("/activity")}>     → /p/<name>/activity
//
// Deployment-level pages (login) have no project; prefix() is the identity
// there, so shared components degrade instead of crashing.
import { createContext, useContext, type ReactNode } from "react";

interface ProjectContextValue {
  /** Current project name, or null on deployment-level pages. */
  project: string | null;
  /** Prefix an app-absolute path ("/api/x", "/agents/1") with /p/<name>. */
  prefix: (path: string) => string;
}

const ProjectContext = createContext<ProjectContextValue>({
  project: null,
  prefix: (path) => path,
});

export function ProjectProvider({ name, children }: { name: string | null; children: ReactNode }) {
  const value: ProjectContextValue = {
    project: name,
    prefix: name ? (path) => `/p/${name}${path}` : (path) => path,
  };
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  return useContext(ProjectContext);
}

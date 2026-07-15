// Per-request project resolution — the server-side other half of the
// /p/<name> URL scheme. proxy.ts strips the prefix and stamps the project
// name into the PROJECT_HEADER request header; everything downstream
// (orcFetch, gateway calls, repos.json, localConfig) resolves through here.
import { headers } from "next/headers";
import { PROJECT_HEADER } from "./config";
import { getRegistryProject, type RegistryProject } from "./registry";

/** The project name for this request, or null (deployment-level routes). */
export async function currentProjectName(): Promise<string | null> {
  const h = await headers();
  return h.get(PROJECT_HEADER) || null;
}

/** The registry entry for this request's project, or null. */
export async function currentProject(): Promise<RegistryProject | null> {
  const name = await currentProjectName();
  return name ? getRegistryProject(name) : null;
}

/**
 * The registry entry for this request's project, throwing a 404-shaped error
 * if the header is missing or the project doesn't exist. Route handlers that
 * are meaningless without a project use this.
 */
export async function requireProject(): Promise<RegistryProject> {
  const p = await currentProject();
  if (!p) {
    throw Object.assign(new Error("Unknown project"), { status: 404 });
  }
  return p;
}

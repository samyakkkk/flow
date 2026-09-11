// Thin fetch wrapper for orchestrator API — always server-side. Resolves the
// orchestrator URL from this request's project (x-flow-project header) so one
// dashboard process can front every project on the deployment.
import { requireProject } from "./projectContext";

export async function orcFetch(
  path: string,
  token: string,
  opts: RequestInit = {}
): Promise<Response> {
  const project = await requireProject();
  const url = `${project.orchestratorUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...(opts.headers as Record<string, string> | undefined),
  };
  return fetch(url, { ...opts, headers, cache: "no-store" });
}

export async function orcGet<T>(path: string, token: string): Promise<T> {
  const res = await orcFetch(path, token);
  if (!res.ok) throw new Error(`Orchestrator ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function orcPatch<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await orcFetch(path, token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Orchestrator PATCH ${path} → ${res.status}: ${err}`);
  }
  return res.json() as Promise<T>;
}

export async function orcPost<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await orcFetch(path, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Orchestrator POST ${path} → ${res.status}: ${err}`);
  }
  return res.json() as Promise<T>;
}

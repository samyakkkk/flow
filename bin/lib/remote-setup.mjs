import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reuse only the explicitly named personal remote. Discovery still rechecks
// both endpoint identities and credentials before any setup files are written.
export function savedRemoteBinding(flowDir, project, repoDir) {
  function read(name) {
    try { return JSON.parse(readFileSync(join(flowDir, name), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error(`Cannot read Flow ${name}; repair the personal configuration before setup.`);
    }
  }
  const entry = read("config.json").projects?.[project];
  if (entry?.remote !== "http") return null;
  const binding = read("integrations.json").repos?.[repoDir];
  return { gatewayUrl: entry.gatewayUrl, orchestratorUrl: entry.orchestratorUrl,
    token: entry.token, repo: binding?.project === project ? binding.repo : undefined };
}

export function connectionUrl(value) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Remote Flow connections require HTTPS (HTTP is allowed only on loopback).");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Flow URLs cannot contain credentials, query strings, or fragments.");
  return url.href.replace(/\/+$/, "");
}

export async function discoverRemote({ project, gatewayUrl, orchestratorUrl, token }) {
  if (!token?.trim()) throw new Error("The token environment variable is missing or empty.");
  const gateway = connectionUrl(gatewayUrl);
  const orchestrator = connectionUrl(orchestratorUrl);
  const res = await fetch(`${gateway}/v1/connection`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw Object.assign(new Error(`Flow connection discovery failed (HTTP ${res.status}).`), { status: res.status });
  const info = await res.json();
  if (info.project !== project || typeof info.graph !== "string" || !info.graph) {
    throw new Error("The remote endpoint does not match the requested Flow project.");
  }
  // Verify the capture endpoint independently before saving a binding. The
  // caller explicitly supplies both URLs; no server-selected credential hop.
  const capture = await fetch(`${orchestrator}/v1/connection`, {
    headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!capture.ok) throw Object.assign(new Error(`Flow capture connection failed (HTTP ${capture.status}).`), { status: capture.status });
  const captureInfo = await capture.json();
  if (captureInfo.project !== project || captureInfo.graph !== info.graph) {
    throw new Error("Knowledge and capture endpoints must belong to the same Flow project.");
  }
  return { remote: "http", gatewayUrl: gateway, orchestratorUrl: orchestrator,
    mcpUrl: `${gateway}/mcp`, graphName: info.graph, token };
}

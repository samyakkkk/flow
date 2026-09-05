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
  if (!res.ok) throw new Error(`Flow connection discovery failed (HTTP ${res.status}).`);
  const info = await res.json();
  if (info.project !== project || typeof info.graph !== "string" || !info.graph) {
    throw new Error("The remote endpoint does not match the requested Flow project.");
  }
  // Verify the capture endpoint independently before saving a binding. The
  // caller explicitly supplies both URLs; no server-selected credential hop.
  const health = await fetch(`${orchestrator}/health`, { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!health.ok) throw new Error(`Flow capture service is unavailable (HTTP ${health.status}).`);
  return { remote: "http", gatewayUrl: gateway, orchestratorUrl: orchestrator,
    mcpUrl: `${gateway}/mcp`, graphName: info.graph, token };
}

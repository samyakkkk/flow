// Browser-side execution-API client — the dual-origin half of the
// local-control-plane/remote-brain architecture. A page served by a PROD
// deployment (flow.acme.com) discovers the local Flow on the machine the
// browser is sitting on and talks to it directly (localhost:7600) — no
// proxying, no relay, zero internet hops for session interactivity. Brain
// data keeps flowing same-origin to the deployment that served the page.
//
// Discovery: GET /api/machines (same-origin, session-authed) lists the
// user's connected machines with their pairing secrets; we try each against
// the local dashboard's execution door (dashboard/src/proxy.ts) — only the
// machine under this browser answers. The working pairing is cached in
// sessionStorage.

export const LOCAL_DASHBOARD = "http://localhost:7600";

export interface LocalLink {
  base: string;
  pairing: string;
}

interface Machine {
  id: string;
  label: string;
  pairing: string;
}

const CACHE_KEY = "flow_local_pairing";

async function probe(pairing: string): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_DASHBOARD}/api/auth/status`, {
      headers: { "x-flow-pairing": pairing },
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false; // not running, door closed, or PNA/preflight refused
  }
}

/** Find this machine's local Flow, or null (not running / not connected). */
export async function discoverLocal(): Promise<LocalLink | null> {
  // Same-origin case: the page IS the local dashboard — no door needed.
  if (typeof window !== "undefined" && window.location.origin === LOCAL_DASHBOARD) {
    return { base: "", pairing: "" };
  }

  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached && (await probe(cached))) return { base: LOCAL_DASHBOARD, pairing: cached };
  sessionStorage.removeItem(CACHE_KEY);

  let machines: Machine[] = [];
  try {
    const res = await fetch("/api/machines", { cache: "no-store" });
    if (res.ok) machines = ((await res.json()).machines ?? []) as Machine[];
  } catch {
    return null;
  }
  for (const m of machines) {
    if (!m.pairing) continue;
    if (await probe(m.pairing)) {
      sessionStorage.setItem(CACHE_KEY, m.pairing);
      return { base: LOCAL_DASHBOARD, pairing: m.pairing };
    }
  }
  return null;
}

/** Fetch against the local Flow through the execution door. */
export function localFetch(link: LocalLink, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (link.pairing) headers.set("x-flow-pairing", link.pairing);
  return fetch(`${link.base}${path}`, { ...init, headers, cache: "no-store" });
}

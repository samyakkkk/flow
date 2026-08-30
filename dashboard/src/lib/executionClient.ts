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

export const DEFAULT_LOCAL_DASHBOARD = "http://localhost:7600";

export interface LocalLink {
  base: string;
  pairing: string;
}

interface Machine {
  id: string;
  label: string;
  pairing: string;
  localUrl?: string;
}

const CACHE_KEY = "flow_local_link";

async function probe(base: string, pairing: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/auth/status`, {
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
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const link = JSON.parse(cached) as LocalLink;
      if (await probe(link.base, link.pairing)) return link;
    } catch {
      // fall through to rediscovery
    }
    sessionStorage.removeItem(CACHE_KEY);
  }

  let machines: Machine[] = [];
  try {
    const res = await fetch("/api/machines", { cache: "no-store" });
    if (res.ok) machines = ((await res.json()).machines ?? []) as Machine[];
  } catch {
    return null;
  }
  for (const m of machines) {
    if (!m.pairing) continue;
    const base = m.localUrl ?? DEFAULT_LOCAL_DASHBOARD;
    // The page IS this machine's local dashboard — same origin, no door.
    if (typeof window !== "undefined" && window.location.origin === base) {
      return { base: "", pairing: "" };
    }
    if (await probe(base, m.pairing)) {
      const link = { base, pairing: m.pairing };
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(link));
      return link;
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

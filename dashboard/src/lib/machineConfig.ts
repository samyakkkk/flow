import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// The machine-level ~/.flow/config.json written by `flow connect` — the
// deployments ("remotes") this machine holds credentials for. The LOCAL
// dashboard reads it to answer two questions about a cross-origin request:
// is this Origin a deployment we connected to, and does the caller hold that
// remote's pairing secret? Server-side only; short TTL cache like the
// registry so a fresh `flow connect` works without a dashboard restart.

export interface RemoteEntry {
  kind?: "local" | "remote";
  deploymentId?: string;
  url: string;
  token?: string;
  pairing?: string;
  localUrl?: string;
  connectedAt?: string;
}

const CACHE_TTL_MS = 2000;
let cache: { at: number; remotes: Record<string, RemoteEntry> } | null = null;

export function loadRemotes(): Record<string, RemoteEntry> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.remotes;
  let remotes: Record<string, RemoteEntry> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(homedir(), ".flow", "config.json"), "utf-8")) as {
      remotes?: Record<string, RemoteEntry>;
    };
    remotes = raw.remotes ?? {};
  } catch {
    // No config, no remotes — the door stays closed.
  }
  cache = { at: now, remotes };
  return remotes;
}

/** The remote whose dashboard URL has this web origin, or null. */
export function remoteForOrigin(origin: string): RemoteEntry | null {
  for (const remote of Object.values(loadRemotes())) {
    try {
      if (new URL(remote.url).origin === origin) return remote;
    } catch {
      // Malformed URL in config — skip.
    }
  }
  return null;
}

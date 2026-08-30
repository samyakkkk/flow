// Remembered kickoff configuration — the composer's answer to "I always pick
// the same model/mode/folder, stop resetting me to the agent defaults".
// Last-used wins: every successful session start records the choices made
// (engine, work folder, and per-engine config/mode), and the next composer
// mount seeds from them. Values are validated against what the agent
// currently advertises before being applied, so a stale model or mode id
// silently falls back to the agent's own default.
//
// Stored client-side in localStorage, keyed per project — kickoff choices are
// a per-person, per-browser concern, same as the flow_last_project cookie.

export interface BackendKickoffPrefs {
  /** Explicit config values (model selector, thought toggles) last launched with. */
  config?: Record<string, string | boolean>;
  /** Mode id last launched with. */
  modeId?: string;
}

export interface KickoffPrefs {
  /** Last-used engine id (claude/codex/opencode). */
  backend?: string;
  /** Last-used work folder path. */
  workFolder?: string;
  /** Per-engine config memory — switching engines keeps each one's choices. */
  byBackend?: Record<string, BackendKickoffPrefs>;
}

function storageKey(project: string | null): string {
  return `flow.kickoff.${project ?? "@none"}`;
}

export function loadKickoffPrefs(project: string | null): KickoffPrefs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(project));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as KickoffPrefs) : {};
  } catch {
    return {};
  }
}

export function rememberKickoff(
  project: string | null,
  used: {
    backend: string;
    workFolder?: string;
    config?: Record<string, string | boolean>;
    modeId?: string;
  }
): void {
  if (typeof window === "undefined" || !used.backend) return;
  try {
    const prefs = loadKickoffPrefs(project);
    prefs.backend = used.backend;
    if (used.workFolder) prefs.workFolder = used.workFolder;
    prefs.byBackend = {
      ...(prefs.byBackend ?? {}),
      [used.backend]: {
        // An empty config means "launched on agent defaults" — store nothing
        // so a deliberate revert to defaults is also remembered.
        config:
          used.config && Object.keys(used.config).length > 0 ? used.config : undefined,
        modeId: used.modeId,
      },
    };
    window.localStorage.setItem(storageKey(project), JSON.stringify(prefs));
  } catch {
    // Best-effort — blocked or full storage must never break kickoff.
  }
}

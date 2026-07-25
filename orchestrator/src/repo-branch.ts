// Shared GitHub default-branch resolution. Connection entry points must use
// this instead of inventing "main" before the repository has been inspected.

import { getSetting } from "./settings.js";

export async function resolveGithubDefaultBranch(url: string): Promise<string> {
  return (await githubDefaultBranch(url)) ?? "main";
}

// Strict variant: null when the branch genuinely can't be resolved (non-GitHub
// URL, API error). The drift check needs this — a "main" fallback would flag
// false drift on every non-main repo whenever the API hiccups.
export async function githubDefaultBranch(url: string): Promise<string | null> {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match) return null;

  const [, owner, name] = match;
  try {
    const token = getSetting("GITHUB_TOKEN");
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { default_branch?: string };
    return body.default_branch?.trim() || null;
  } catch {
    return null;
  }
}

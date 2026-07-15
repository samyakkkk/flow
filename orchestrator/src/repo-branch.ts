// Shared GitHub default-branch resolution. Connection entry points must use
// this instead of inventing "main" before the repository has been inspected.

import { getSetting } from "./settings.js";

export async function resolveGithubDefaultBranch(url: string): Promise<string> {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match) return "main";

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
    if (!res.ok) return "main";
    const body = (await res.json()) as { default_branch?: string };
    return body.default_branch?.trim() || "main";
  } catch {
    return "main";
  }
}

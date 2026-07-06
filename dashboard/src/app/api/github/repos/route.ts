import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { readLocalConfig } from "@/lib/localConfig";
import { orcFetch } from "@/lib/orchestrator";
import { execSync } from "node:child_process";

interface GhCliRepo {
  nameWithOwner: string;
  url: string;
  defaultBranchRef?: { name: string } | null;
}

interface GitHubApiRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
}

interface RepoResult {
  full_name: string;
  url: string;
  default_branch: string;
}

interface ReposResponse {
  source: "gh_cli" | "pat" | "none";
  repos: RepoResult[];
  hint?: string;
}

function tryGhCli(): RepoResult[] | null {
  try {
    // Check if gh is authenticated
    execSync("gh auth status", { stdio: "pipe", timeout: 5000 });
    // List repos as JSON
    const out = execSync(
      "gh repo list --json nameWithOwner,url,defaultBranchRef --limit 100",
      { stdio: "pipe", timeout: 15000 }
    ).toString("utf8");
    const parsed = JSON.parse(out) as GhCliRepo[];
    return parsed.map((r) => ({
      full_name: r.nameWithOwner,
      url: r.url,
      default_branch: r.defaultBranchRef?.name ?? "main",
    }));
  } catch {
    return null;
  }
}

async function tryGitHubPat(pat: string): Promise<RepoResult[] | null> {
  try {
    const res = await fetch(
      "https://api.github.com/user/repos?per_page=100&sort=updated",
      {
        headers: {
          Authorization: `token ${pat}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return null;
    const repos = (await res.json()) as GitHubApiRepo[];
    return repos.map((r) => ({
      full_name: r.full_name,
      url: r.html_url,
      default_branch: r.default_branch,
    }));
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Try gh CLI first (local-mode convenience)
  const ghRepos = tryGhCli();
  if (ghRepos) {
    return NextResponse.json({ source: "gh_cli", repos: ghRepos } satisfies ReposResponse);
  }

  // Fall back to stored GitHub PAT
  const cfg = readLocalConfig();
  const pat = cfg["github_pat"] ?? "";
  if (pat) {
    const patRepos = await tryGitHubPat(pat);
    if (patRepos) {
      return NextResponse.json({ source: "pat", repos: patRepos } satisfies ReposResponse);
    }
  }

  return NextResponse.json({
    source: "none",
    repos: [],
    hint: "Log in with `gh auth login` locally, or paste a fine-grained PAT below.",
  } satisfies ReposResponse);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { action?: string; pat?: string; repos?: RepoResult[] };

  // Save a GitHub PAT.
  // KNOWN DUPLICATION: the PAT is written to both the dashboard-local AES store
  // (for this route's own listing calls, since orchestrator secrets come masked)
  // and to the orchestrator settings (GITHUB_TOKEN) as the source of truth for
  // pollers and agents. The orchestrator value wins for server-side operations;
  // the local copy is a convenience for the /api/github/repos listing path only.
  if (body.action === "save_pat" && body.pat) {
    const { writeLocalConfig } = await import("@/lib/localConfig");
    writeLocalConfig({ github_pat: body.pat });
    // Also propagate to orchestrator settings (best-effort; don't block on failure)
    try {
      await orcFetch("/v1/settings", token, {
        method: "PUT",
        body: JSON.stringify({ GITHUB_TOKEN: body.pat }),
      });
    } catch {
      // Orchestrator may not have /v1/settings yet; local store is the fallback
    }
    return NextResponse.json({ ok: true });
  }

  // Add selected repos to the project registry
  if (body.action === "add_repos" && Array.isArray(body.repos)) {
    const results: Array<{ full_name: string; ok: boolean; error?: string }> = [];
    for (const repo of body.repos) {
      try {
        await orcFetch("/v1/events", token, {
          method: "POST",
          body: JSON.stringify({
            source: "dashboard",
            type: "repo_added",
            ts: Date.now(),
            payload: {
              url: repo.url,
              branch: repo.default_branch ?? "main",
              localClone: false,
            },
          }),
        });
        results.push({ full_name: repo.full_name, ok: true });
      } catch (err) {
        results.push({ full_name: repo.full_name, ok: false, error: (err as Error).message });
      }
    }
    return NextResponse.json({ ok: true, results });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

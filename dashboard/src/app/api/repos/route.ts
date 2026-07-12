import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcPost } from "@/lib/orchestrator";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

// Resolved at request time (not module scope) so the bundler doesn't flag a
// dynamic filesystem expression. REPOS_JSON_PATH is set per project by
// `flow up`; the process.cwd() fallback is only for a bare single-workspace dev
// layout.
function reposJsonPath(): string {
  const fromEnv = process.env.REPOS_JSON_PATH;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "..", "index-workspace", "repos.json");
}

interface RepoEntry {
  name: string;
  url: string;
  branch: string;
  lastIndexedCommit?: string;
  addedAt: string;
  lastIndexedAt?: string;
  [key: string]: unknown;
}

interface ReposFile {
  repos: RepoEntry[];
}

function readRepos(): ReposFile {
  try {
    const raw = fs.readFileSync(reposJsonPath(), "utf8");
    return JSON.parse(raw) as ReposFile;
  } catch {
    return { repos: [] };
  }
}

function writeRepos(data: ReposFile): void {
  fs.writeFileSync(reposJsonPath(), JSON.stringify(data, null, 2), "utf8");
}

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(readRepos());
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { action: string; repoName?: string; branch?: string };

  if (body.action === "reindex" && body.repoName) {
    try {
      const data = await orcPost("/v1/events", token, {
        source: "dashboard",
        type: "reindex_request",
        ts: Date.now(),
        payload: { repoName: body.repoName, jobType: "index_repo" },
      });
      return NextResponse.json({
        ok: true,
        note: "Reindex event posted. Orchestrator will enqueue an index_repo job.",
        data,
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
  }

  if (body.action === "remove" && body.repoName) {
    try {
      const file = readRepos();
      const before = file.repos.length;
      file.repos = file.repos.filter((r) => r.name !== body.repoName);
      if (file.repos.length === before) {
        return NextResponse.json({ error: "Repo not found" }, { status: 404 });
      }
      writeRepos(file);
      // Notify the orchestrator so it can clean up in-memory state
      try {
        await orcPost("/v1/events", token, {
          source: "dashboard",
          type: "repo_removed",
          ts: Date.now(),
          payload: { repoName: body.repoName },
        });
      } catch {
        // best-effort — the write already succeeded
      }
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  if (body.action === "change_branch" && body.repoName && body.branch) {
    try {
      const file = readRepos();
      const repo = file.repos.find((r) => r.name === body.repoName);
      if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
      repo.branch = body.branch;
      writeRepos(file);
      // Enqueue a reindex so the new branch is reflected in the graph
      try {
        await orcPost("/v1/events", token, {
          source: "dashboard",
          type: "reindex_request",
          ts: Date.now(),
          payload: { repoName: body.repoName, jobType: "index_repo" },
        });
      } catch {
        // best-effort
      }
      return NextResponse.json({ ok: true, note: "Branch updated. Reindex queued." });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

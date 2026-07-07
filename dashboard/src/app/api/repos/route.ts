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

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(readRepos());
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { action: string; repoName?: string };
  if (body.action === "reindex" && body.repoName) {
    // Enqueue an index_repo job via orchestrator
    // NOTE: orchestrator /v1/ask creates answer jobs; index_repo must be enqueued through
    // the same job queue. As of v1, there's no dedicated HTTP endpoint for index_repo jobs.
    // We post an event that the orchestrator can route to a job enqueue.
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

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

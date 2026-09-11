import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

// GET /api/fs/branches?path=<absPath> — list local git branches for a
// directory on the server's filesystem. Used by AddFolder when the repo isn't
// in the orchestrator registry yet.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const p = req.nextUrl.searchParams.get("path") ?? "";
  if (!p) return NextResponse.json({ error: "path required" }, { status: 400 });

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", p, "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
      { timeout: 10_000 }
    );
    const branches = stdout
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return NextResponse.json({ branches });
  } catch {
    return NextResponse.json({ branches: [] });
  }
}

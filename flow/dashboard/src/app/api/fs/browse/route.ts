import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { readdirSync } from "fs";
import { homedir } from "os";
import { join, dirname, resolve } from "path";

// GET /api/fs/browse?path= — list directory contents for the folder picker.
// Only meaningful in local mode (AddFolder is hidden in prod), but auth-gated either way.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let requestedPath = req.nextUrl.searchParams.get("path") ?? "";
  if (!requestedPath || requestedPath === "~") requestedPath = homedir();
  const safePath = resolve(requestedPath);

  try {
    const rawEntries = readdirSync(safePath, { withFileTypes: true });
    const entries = rawEntries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        path: join(safePath, e.name),
        isDir: e.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parent = safePath !== "/" ? dirname(safePath) : null;
    return NextResponse.json({ path: safePath, parent, entries });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

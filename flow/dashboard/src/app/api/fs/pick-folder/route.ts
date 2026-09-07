import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

// POST /api/fs/pick-folder — launch the native macOS Finder dialog and return
// the selected folder path. macOS only; returns 400 on other platforms.
// Returns { path: string } on success, { cancelled: true } if the user
// dismissed the dialog, or { error: string } on failure.
export async function POST(): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (process.platform !== "darwin") {
    return NextResponse.json({ error: "Native picker only available on macOS" }, { status: 400 });
  }

  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Select a project folder")'],
      { timeout: 120_000 }
    );
    const path = stdout.trim().replace(/\/$/, "");
    if (!path) return NextResponse.json({ cancelled: true });
    return NextResponse.json({ path });
  } catch (err: unknown) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("User canceled") || msg.includes("user canceled")) {
      return NextResponse.json({ cancelled: true });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

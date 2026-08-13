import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { trackNativePick, untrackNativePick, cancelNativePick } from "@/lib/nativePick";

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

  // A new pick supersedes a pending one so dialogs never stack on-screen.
  cancelNativePick();
  const pending = execFileAsync(
    "osascript",
    ["-e", 'POSIX path of (choose folder with prompt "Select a project folder")'],
    { timeout: 120_000 }
  );
  trackNativePick(pending.child);
  try {
    const { stdout } = await pending;
    const path = stdout.trim().replace(/\/$/, "");
    if (!path) return NextResponse.json({ cancelled: true });
    return NextResponse.json({ path });
  } catch (err: unknown) {
    const msg = (err as Error).message ?? "";
    const e = err as { killed?: boolean; signal?: string | null };
    // A killed child is /api/fs/native-pick/cancel dismissing the dialog for
    // a remote browser — a cancel, not a failure.
    if (msg.includes("User canceled") || msg.includes("user canceled") || e.killed || e.signal) {
      return NextResponse.json({ cancelled: true });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    untrackNativePick(pending.child);
  }
}

// /api/fs/native-pick — open the OS-native folder chooser ON THE SERVER and
// return the chosen absolute path. Browsers deliberately never expose real
// filesystem paths from their own pickers; in local mode the dashboard server
// runs on the user's machine, so it can host the native dialog instead.
// macOS only for now; callers fall back to the in-page browser elsewhere
// (and on remote deployments, where "the server's screen" isn't the user's).
import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { requireProject } from "@/lib/projectContext";

const SCRIPT = [
  'tell application "System Events" to activate',
  'POSIX path of (choose folder with prompt "Connect a repository to Flow")',
].flatMap((line) => ["-e", line]);

export async function POST(): Promise<NextResponse> {
  // Prod deployments run this server far from the user's screen — a native
  // dialog there would open on the SERVER. Local mode only.
  const project = await requireProject();
  if (project.mode !== "local" || process.platform !== "darwin") {
    return NextResponse.json({ unsupported: true });
  }
  return new Promise<NextResponse>((resolve) => {
    execFile("osascript", SCRIPT, { timeout: 5 * 60 * 1000 }, (err, stdout) => {
      if (err) {
        // Exit 1 + "User canceled" (-128) is the normal dismiss; a killed
        // process (timeout, shutdown) counts as a dismiss too, not as
        // platform-unsupported — only genuine launch failures disable native.
        const e = err as { message?: string; killed?: boolean; signal?: string | null };
        const canceled = /canceled|cancelled|-128/i.test(String(e.message)) || e.killed === true || !!e.signal;
        resolve(NextResponse.json(canceled ? { canceled: true } : { unsupported: true }));
        return;
      }
      const path = stdout.trim().replace(/\/$/, "");
      resolve(NextResponse.json(path ? { path } : { canceled: true }));
    });
  });
}

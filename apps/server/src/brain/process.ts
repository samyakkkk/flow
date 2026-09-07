// @effect-diagnostics globalTimers:off - Captured native child lifecycle and escalation deadlines.
// @effect-diagnostics nodeBuiltinImport:off - Native database/CLI adapter owns Node lifecycle and filesystem I/O.
import * as NodeChildProcess from "node:child_process";

export function run(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    input?: string;
    preserveOutput?: boolean;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeout ?? 30_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: options.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      },
      (error, stdout, stderr) => {
        // Never forward stderr: auth helpers and providers can include credentials in errors.
        if (error && /unknown variant.*max|failed to decode models response/.test(stderr)) {
          reject(
            new Error(
              "This Codex version cannot read current model metadata. Update Codex in Settings → Providers, or choose Claude Code.",
            ),
          );
        } else if (error)
          reject(
            new Error(
              `${executable} failed${options.signal?.aborted ? " (cancelled)" : ""}. Check that it is installed and signed in.`,
            ),
          );
        else resolve(options.preserveOutput ? stdout : stdout.trim());
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
  });
}

export function githubRepository(input: string): string {
  const value = input
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9_.-]{1,100}$/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Enter a GitHub repository as owner/repository or an https://github.com URL.");
  }
  return value;
}

/** Stream provider events without buffering an entire indexing transcript in memory. */
export async function runStreaming(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    timeout: number;
    platform: NodeJS.Platform;
    transcript: string;
    onLine: (line: string) => void;
  },
): Promise<void> {
  const fs = await import("node:fs");
  const readline = await import("node:readline");
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(options.transcript, { mode: 0o600 });
    const child = NodeChildProcess.spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: options.platform !== "win32",
      windowsHide: true,
    });
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        // This group belongs only to the child spawned above, including its MCPs.
        if (options.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already exited */
      }
    };
    const abort = () => {
      failure ??= new Error("Indexing cancelled.");
      kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 3000);
      escalation.unref();
    };
    const timer = setTimeout(() => {
      failure = new Error("Indexing timed out. Retry to continue from the graph already written.");
      abort();
    }, options.timeout);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        options.onLine(line);
      } catch {
        /* malformed event does not terminate indexing */
      }
    });
    child.stdout.pipe(output, { end: false });
    // Retained locally for debugging, never sent verbatim to the UI.
    child.stderr.pipe(output, { end: false });
    output.on("error", (error) => {
      failure = error;
      abort();
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      options.signal.removeEventListener("abort", abort);
      lines.close();
      kill("SIGTERM");
      output.end(() => {
        if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new Error(
              `${executable} indexing failed (exit ${code}). Check its sign-in and usage limits. The graph already written is preserved.`,
            ),
          );
        else resolve();
      });
    });
  });
}

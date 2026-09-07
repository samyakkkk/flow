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

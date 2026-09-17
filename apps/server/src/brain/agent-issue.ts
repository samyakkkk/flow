import type { BrainAgentIssue, BrainCli } from "@t3tools/contracts";

const NAMES: Record<BrainCli, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

// Provider CLIs report these conditions in prose only, so recognition is by
// phrase. Order matters: a usage limit often arrives as an HTTP 429 alongside
// words like "authorization", and must not read as a sign-out.
const USAGE_LIMIT =
  /usage limit|rate limit|rate_limit|limit reached|limit exceeded|too many requests|\b429\b|quota|out of credits|credit balance|insufficient credit|billing|upgrade your plan|try again (?:at|in) /i;
const SIGNED_OUT =
  /\/login|not logged in|logged out|log ?in required|please (?:log|sign) ?in|sign(?:ed)? ?out|unauthori[sz]ed|\b401\b|invalid api key|api key (?:is )?(?:missing|invalid)|authentication|oauth token|token (?:has )?expired|credentials/i;
const UNAVAILABLE =
  /before choosing it|before indexing|is not installed|not installed|command not found|\bENOENT\b|Enable a .* provider|no supported extraction CLI/i;

/**
 * Why a Brain's agent could not run, when the cause is one the user can fix.
 * `activity` is what stopped ("Indexing", "Notes"). Returns undefined for
 * failures that are not about the agent's account or installation; the text a
 * provider printed is never forwarded, only recognised.
 */
export function classifyAgentIssue(
  text: string | null | undefined,
  cli: BrainCli,
  activity: "Indexing" | "Notes",
): BrainAgentIssue | undefined {
  if (!text) return undefined;
  const name = NAMES[cli];
  const verb = activity === "Notes" ? "are" : "is";
  if (USAGE_LIMIT.test(text))
    return {
      kind: "usageLimit",
      cli,
      message: `${activity} ${verb} paused: ${name} reached its usage limit. It resumes when the limit resets, or choose another agent in Brain settings.`,
    };
  if (SIGNED_OUT.test(text))
    return {
      kind: "signedOut",
      cli,
      message: `${activity} ${verb} paused: ${name} is signed out on this computer. Sign in to ${name}, or choose another agent in Brain settings.`,
    };
  if (UNAVAILABLE.test(text))
    return {
      kind: "unavailable",
      cli,
      message: `${activity} ${verb} paused: ${name} is not available on this computer. Install or enable it, or choose another agent in Brain settings.`,
    };
  return undefined;
}

/** The Brain agent behind an executable path, when the name reveals it. */
export function cliFromExecutable(executable: string): BrainCli | undefined {
  const base = executable.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (base.startsWith("claude")) return "claude";
  if (base.startsWith("codex")) return "codex";
  if (base.startsWith("opencode")) return "opencode";
  return undefined;
}

/**
 * The agent on this computer that writes conversation notes. A local Brain uses
 * its own agent. A cloud Brain's notes are still written here, so the agent the
 * user chose wins when it is installed, then the machine default's provider,
 * then any installed agent.
 */
export function chooseNotesCli(input: {
  readonly remote: boolean;
  readonly chosen: BrainCli;
  readonly installed: ReadonlyArray<BrainCli>;
  readonly machineDefault: BrainCli | undefined;
}): BrainCli {
  if (!input.remote || input.installed.includes(input.chosen)) return input.chosen;
  if (input.machineDefault && input.installed.includes(input.machineDefault))
    return input.machineDefault;
  return input.installed[0] ?? input.chosen;
}

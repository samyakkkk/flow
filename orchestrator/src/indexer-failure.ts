// indexer-failure.ts — turn raw indexer-job failures into something a user can
// act on. The graph is the first place a new user sees value; when indexing
// dies (Claude logged out, CLI missing, FalkorDB down, private clone denied)
// the failure must say WHAT broke and HOW to fix it, not dump a stderr tail
// into a DB row nobody reads. Classification is shared by every backend
// (opencode/codex/claude); the classified shape lands in the job's
// result_json, the index_log trail, and /v1/repos/status → the dashboard.

import type { IndexerBackend } from "./indexer-runtime.js";

export type IndexFailureCode =
  | "cli_not_installed" // no coding CLI on PATH (or the forced one is missing)
  | "cli_auth"          // CLI is signed out / key invalid — the #1 silent killer
  | "cli_limit"         // credits/quota/rate limit on the CLI's provider
  | "gateway_down"      // graph-gateway not answering — nothing can be written
  | "db_down"           // FalkorDB unreachable behind the gateway
  | "clone_auth"        // git clone/fetch denied (private repo, bad token)
  | "clone_failed"      // git clone/fetch/reset failed for non-auth reasons
  | "timeout"           // job hit the indexer timeout
  | "killed"            // child died without an exit code (killed/crashed)
  | "unknown";

export interface IndexFailure {
  code: IndexFailureCode;
  // One human sentence, safe to render verbatim in the dashboard.
  message: string;
  // The fix, as a concrete action ("run `claude` and /login"), when known.
  hint?: string;
  // Trimmed raw error tail for debugging (job-logs/ has the full transcript).
  detail?: string;
}

// Thrown by backends/preflight so runJob's catch can persist the structured
// failure instead of String(err).
export class IndexerFailureError extends Error {
  readonly failure: IndexFailure;
  constructor(failure: IndexFailure) {
    super(failure.message);
    this.name = "IndexerFailureError";
    this.failure = failure;
  }
}

const CLI_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
};

function cliName(backend?: string): string {
  return (backend && CLI_NAMES[backend]) ?? "Coding CLI";
}

// How to sign back in, per backend. Claude Code logs users out frequently —
// this hint is the difference between "indexing silently broken for a week"
// and a 30-second fix.
function authHint(backend?: string): string {
  switch (backend) {
    case "claude":
      return "Open a terminal, run `claude`, and complete /login. Then hit Reindex.";
    case "codex":
      return "Run `codex login` in a terminal, then hit Reindex.";
    case "opencode":
      return "Run `opencode auth login` in a terminal (or set an OpenRouter key in Settings), then hit Reindex.";
    default:
      return "Sign in to your coding CLI again, then hit Reindex.";
  }
}

// Signed-out / bad-credential shapes across the three CLIs. Matched against
// stderr + stdout tails + the thrown message, case-insensitively.
const AUTH_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /please run \/login/i,
  /oauth token .*(expired|revoked|invalid)/i,
  /token (has )?expired/i,
  /refresh.{0,20}token/i,
  /not (currently )?logged in/i,
  /authentication[_ ]?(error|failed)/i,
  /invalid[_ -]?api[_ -]?key/i,
  /no credentials found/i,
  /missing api key/i,
  /api key not (set|found|configured)/i,
  /\b401\b/,
  /unauthori[sz]ed/i,
];

const LIMIT_PATTERNS: RegExp[] = [
  /credit balance is too low/i,
  /insufficient (credits|quota|funds)/i,
  /usage limit/i,
  /rate[- ]?limit/i,
  /quota exceeded/i,
  /\b(402|429)\b/,
];

const NOT_INSTALLED_PATTERNS: RegExp[] = [
  /not found on PATH/i,
  /\bENOENT\b/,
  /command not found/i,
  /No such file or directory/i,
];

const CLONE_AUTH_PATTERNS: RegExp[] = [
  /authentication failed/i,
  /could not read username/i,
  /permission denied/i,
  /repository not found/i, // GitHub's answer for private-without-access
  /\b403\b/,
];

function firstMeaningfulLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .find((l) => !/^\s*at /.test(l)) ?? ""
  );
}

export interface RawFailure {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
}

// Map a raw failure to a classified one. Order matters: "not installed" and
// timeouts are unambiguous; auth/limit are matched before the generic
// connection checks because a 401 body often ALSO mentions the request URL.
export function classifyIndexerFailure(
  backend: IndexerBackend | string | undefined,
  raw: RawFailure,
): IndexFailure {
  // Tails only: a 45-minute transcript can be huge, and failures print last.
  const hay = [
    raw.errorMessage ?? "",
    (raw.stderr ?? "").slice(-6000),
    (raw.stdout ?? "").slice(-6000),
  ].join("\n");
  const name = cliName(backend);
  const detail =
    firstMeaningfulLine(raw.errorMessage ?? "") ||
    firstMeaningfulLine((raw.stderr ?? "").slice(-2000)) ||
    firstMeaningfulLine((raw.stdout ?? "").slice(-2000)) ||
    undefined;

  if (NOT_INSTALLED_PATTERNS.some((p) => p.test(hay))) {
    return {
      code: "cli_not_installed",
      message: `${name} isn't installed on this machine, so Flow can't index.`,
      hint: "Install a coding CLI (Claude Code, Codex, or opencode) — or pick an installed one in Settings → Indexer. setup.sh installs opencode.",
      detail,
    };
  }

  const timeout = hay.match(/timed out after (\d+)ms/i);
  if (timeout) {
    const mins = Math.round(Number(timeout[1]) / 60000);
    return {
      code: "timeout",
      message: `Indexing ran past its ${mins}-minute limit and was stopped.`,
      hint: "Usually a very large repo or a slow model. Try Reindex; if it repeats, set a faster model via GRAPH_BUILDER_MODEL in Settings.",
      detail,
    };
  }

  // git failures carry their own phrasing from ensureRepoClone/refreshRepoCheckout.
  if (/git (clone|fetch|reset) failed/i.test(hay)) {
    if (CLONE_AUTH_PATTERNS.some((p) => p.test(hay))) {
      return {
        code: "clone_auth",
        message: "Git couldn't access the repository — access was denied.",
        hint: "Private repo? Add or refresh your GitHub token in Settings → GitHub, then Reindex.",
        detail,
      };
    }
    return {
      code: "clone_failed",
      message: "Git couldn't fetch the repository.",
      hint: "Check the URL and branch, and that this machine can reach the remote. Then Reindex.",
      detail,
    };
  }

  if (AUTH_PATTERNS.some((p) => p.test(hay))) {
    return {
      code: "cli_auth",
      message: `${name} is signed out (its login expires from time to time), so indexing can't run.`,
      hint: authHint(backend),
      detail,
    };
  }

  if (LIMIT_PATTERNS.some((p) => p.test(hay))) {
    return {
      code: "cli_limit",
      message: `${name} hit a usage/credit limit while indexing.`,
      hint: "Wait for the limit to reset (or top up credits), then hit Reindex.",
      detail,
    };
  }

  if (/ECONNREFUSED|fetch failed|connection refused|socket hang up/i.test(hay)) {
    const dbish = /6379|falkordb|redis/i.test(hay);
    return dbish
      ? {
          code: "db_down",
          message: "Flow's graph database (FalkorDB) is unreachable, so nothing can be written to the brain.",
          hint: "Is Docker running? Start it, then run `flow up` again.",
          detail,
        }
      : {
          code: "gateway_down",
          message: "Flow's graph gateway isn't responding, so nothing can be written to the brain.",
          hint: "Run `flow up` to restart this project, then check logs/gateway.log if it repeats.",
          detail,
        };
  }

  if (raw.status === null || raw.status === undefined) {
    return {
      code: "killed",
      message: `The ${name} indexer process died before finishing (killed or crashed).`,
      hint: "Hit Reindex. If it repeats, check job-logs/ for the transcript tail.",
      detail,
    };
  }

  return {
    code: "unknown",
    message: `The ${name} indexer exited with an error.`,
    hint: "Hit Reindex; if it repeats, the full transcript is in the project's job-logs/ folder.",
    detail,
  };
}

// Internal lifecycle "errors" that are bookkeeping, not user-facing failures:
// a parked job replaced by a newer one, a repo being removed, a restart
// re-queue. The status machine must never present these as "indexing failed".
export function isInternalFailure(error: string | undefined | null): boolean {
  if (!error) return false;
  return (
    error.startsWith("superseded:") ||
    error === "repo_removed" ||
    error.startsWith("stalled:")
  );
}

// ------------------------------------------------------------------
// Preflight — deterministic environment checks BEFORE spawning a CLI for an
// index job. A dead gateway or FalkorDB otherwise fails 45 minutes later (or
// worse: the CLI "succeeds" while every graph write bounced). Cheap (<5s),
// and the failure names the broken layer directly.
// ------------------------------------------------------------------

export async function preflightIndexEnvironment(): Promise<IndexFailure | null> {
  const gatewayUrl = (process.env.GATEWAY_URL ?? "http://127.0.0.1:7433").replace(/\/+$/, "");
  const token = process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  try {
    const res = await fetch(`${gatewayUrl}/health?deep=1`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return {
        code: "gateway_down",
        message: "Flow's graph gateway isn't healthy, so indexing can't write to the brain.",
        hint: "Run `flow up` to restart this project, then check logs/gateway.log.",
        detail: `GET /health returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { falkordb?: { ok?: boolean; error?: string } };
    // Older gateways don't report falkordb — treat as fine rather than block.
    if (body.falkordb && body.falkordb.ok === false) {
      return {
        code: "db_down",
        message: "Flow's graph database (FalkorDB) is unreachable, so indexing can't write to the brain.",
        hint: "Is Docker running? Start it, then run `flow up` again.",
        detail: body.falkordb.error,
      };
    }
    return null;
  } catch (err) {
    return {
      code: "gateway_down",
      message: "Flow's graph gateway isn't responding, so indexing can't write to the brain.",
      hint: "Run `flow up` to restart this project, then check logs/gateway.log.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// indexer-runtime.ts — backend selection + shared config for the multi-CLI
// indexer. Indexing jobs can run through any locally-installed coding CLI
// (opencode, codex, or claude); this module resolves which one to use and
// builds the pieces the per-backend command builders share (default models,
// the graph-builder instructions, and the flow-graph MCP wiring for the CLIs
// that need it spawned directly).

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FLOW_ROOT,
  GATEWAY_MCP,
  binPath,
  detectAgents,
  resolveLocalExecutable,
} from "./agents/runtime.js";
import { getSetting } from "./settings.js";

export type IndexerBackend = "opencode" | "codex" | "claude";

// Per-backend default models. Kept as one map so bumping a model is a
// one-line change. GRAPH_BUILDER_MODEL (setting or env) overrides these.
export const INDEXER_DEFAULT_MODELS: Record<IndexerBackend, string> = {
  opencode: "opencode/deepseek-v4-flash-free", // a free model opencode ships; zero keys needed
  codex: "gpt-5.6-luna",
  claude: "sonnet", // CLI alias; resolves to Claude Sonnet 5 today
};

// Order the auto resolver walks: first locally-installed CLI wins.
const BACKEND_ORDER: IndexerBackend[] = ["opencode", "codex", "claude"];

export async function resolveIndexerBackend(): Promise<IndexerBackend> {
  const forced = getSetting("INDEXER_RUNTIME") ?? "auto";
  if (forced === "opencode" || forced === "codex" || forced === "claude") {
    // Return the forced backend even if it isn't detected — the spawn failure
    // surfaces a clear error rather than silently picking a different CLI.
    return forced;
  }

  const detected = await detectAgents();
  // A "bundled" agent is Flow's ACP adapter, not a usable standalone CLI — only
  // a real executable on the user's machine ("local"/"explicit") can run a job.
  const usable = new Set(
    detected.filter((a) => a.source === "local" || a.source === "explicit").map((a) => a.id)
  );
  const pick = BACKEND_ORDER.find((b) => usable.has(b));
  if (pick) return pick;

  // No CLI on PATH: report opencode anyway — resolveOpencodeBin throws a
  // clear install-instructions error when the job actually tries to spawn,
  // which is a better failure than silently picking nothing here.
  console.warn("[indexer] no coding CLI found on PATH — index jobs will fail until one is installed (run setup.sh)");
  return "opencode";
}

export function indexerModel(backend: IndexerBackend): string {
  return (
    getSetting("GRAPH_BUILDER_MODEL") ??
    process.env.GRAPH_BUILDER_MODEL ??
    INDEXER_DEFAULT_MODELS[backend]
  );
}

// The graph-builder agent instructions (markdown body only). claude/codex have
// no notion of opencode agents, so we feed the same guidance as a system
// prompt. The workspace copy is authoritative (bin/flow.mjs re-syncs it from
// the template on every start); fall back to the template if it's missing.
export function graphBuilderInstructions(workspaceDir: string): string {
  const workspaceCopy = path.join(workspaceDir, ".opencode", "agents", "graph-builder.md");
  const template = path.join(FLOW_ROOT, "index-workspace", ".opencode", "agents", "graph-builder.md");
  let raw: string;
  try {
    raw = readFileSync(workspaceCopy, "utf8");
  } catch {
    raw = readFileSync(template, "utf8");
  }
  return stripFrontmatter(raw);
}

function stripFrontmatter(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n/);
  return m ? md.slice(m[0].length) : md;
}

// Env for the flow-graph MCP process spawned alongside claude/codex indexing
// runs. Builder mode is the indexer surface (query verbs + entity writes +
// notify) with FLOW_WRITE_SCOPE enforced server-side — the same mode the
// workspace opencode.json uses, so all three backends see identical tools.
export interface McpSpecOpts {
  graphName: string;
  writeScope?: string;
  // Provenance + notify identity. claude passes its full environment down to
  // MCP children so inheritance would suffice there, but codex spawns MCP
  // servers with ONLY the configured env — without these set explicitly,
  // codex-run jobs journal a model-supplied actor and get no notify tool.
  actor?: string;
  job?: { id: string; token: string };
}

export function mcpEnv(opts: McpSpecOpts): Record<string, string> {
  const orchPort = process.env.ORCHESTRATOR_PORT ?? "7500";
  const gatewayUrl = (process.env.GATEWAY_URL ?? "http://127.0.0.1:7433").replace(/\/+$/, "");
  const gatewayToken = process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  const env: Record<string, string> = {
    GATEWAY_MCP_MODE: "builder",
    GRAPH_NAME: opts.graphName,
    FLOW_CORRECTIONS_URL: `http://127.0.0.1:${orchPort}/v1/corrections`,
    // MCP is short-lived; borrow the gateway's one local Gemma instance.
    FLOW_EMBED_URL: `${gatewayUrl}/v1/embed`,
  };
  if (gatewayToken) env.FLOW_EMBED_TOKEN = gatewayToken;
  if (opts.actor) env.FLOW_ACTOR = opts.actor;
  if (opts.job) {
    env.FLOW_JOB_ID = opts.job.id;
    env.FLOW_JOB_TOKEN = opts.job.token;
    env.ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? `http://127.0.0.1:${orchPort}`;
  }
  if (process.env.JOURNAL_PATH) env.JOURNAL_PATH = process.env.JOURNAL_PATH;
  if (process.env.FALKOR_HOST) env.FALKOR_HOST = process.env.FALKOR_HOST;
  if (process.env.FALKOR_PORT) env.FALKOR_PORT = process.env.FALKOR_PORT;
  if (opts.writeScope) env.FLOW_WRITE_SCOPE = opts.writeScope;
  return env;
}

// The flow-graph MCP server spec (command + args + env) for direct-spawn CLIs.
export function mcpServerSpec(opts: McpSpecOpts): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return { command: binPath("tsx"), args: [GATEWAY_MCP], env: mcpEnv(opts) };
}

// Resolve the real, non-Flow-managed CLI executable on the user's machine.
export async function resolveBackendExecutable(backend: IndexerBackend): Promise<string> {
  const localPath = await resolveLocalExecutable(backend);
  if (!localPath) {
    throw new Error(`"${backend}" CLI not found on PATH — install it or set INDEXER_RUNTIME to an installed backend.`);
  }
  return localPath;
}

// Resolve the opencode executable on the user's machine. Flow does NOT bundle
// an opencode binary: the npm-distributed one ships unsigned, and macOS kills
// unsigned arm64 binaries at exec (SIGKILL) — a fallback to it just trades a
// clear error for a mysterious one. setup.sh installs a properly signed build
// (Homebrew / official installer) when no coding CLI is present.
export async function resolveOpencodeBin(): Promise<string> {
  const local = await resolveLocalExecutable("opencode");
  if (local) return local;
  throw new Error(
    "opencode CLI not found on PATH — run setup.sh, or install it: " +
      "`brew install sst/tap/opencode` (macOS) or `curl -fsSL https://opencode.ai/install | bash` (macOS/Linux).",
  );
}

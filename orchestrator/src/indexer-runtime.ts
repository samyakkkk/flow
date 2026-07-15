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
import { getSetting, llmApiKey, llmBaseUrl } from "./settings.js";

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

  // No CLI on PATH: fall back to opencode — Flow bundles the opencode-ai
  // package as a dependency (the job runner resolves it via OPENCODE_BIN), so
  // indexing works on a machine with nothing installed. If even the bundled
  // copy is missing, the spawn failure surfaces its own error.
  console.warn("[indexer] no coding CLI found on PATH — using bundled opencode");
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
// runs. It talks directly to FalkorDB and journals mutations; unlike the
// session MCP it must keep write verbs, so GATEWAY_MCP_READONLY is left unset.
export function mcpEnv(opts: { graphName: string; writeScope?: string }): Record<string, string> {
  const orchPort = process.env.ORCHESTRATOR_PORT ?? "7500";
  const env: Record<string, string> = {
    GRAPH_NAME: opts.graphName,
    FLOW_CORRECTIONS_URL: `http://127.0.0.1:${orchPort}/v1/corrections`,
  };
  if (process.env.JOURNAL_PATH) env.JOURNAL_PATH = process.env.JOURNAL_PATH;
  if (process.env.FALKOR_HOST) env.FALKOR_HOST = process.env.FALKOR_HOST;
  if (process.env.FALKOR_PORT) env.FALKOR_PORT = process.env.FALKOR_PORT;
  const key = llmApiKey();
  if (key) {
    env.LLM_API_KEY = key;
    env.LLM_BASE_URL = llmBaseUrl();
  }
  if (opts.writeScope) env.FLOW_WRITE_SCOPE = opts.writeScope;
  return env;
}

// The flow-graph MCP server spec (command + args + env) for direct-spawn CLIs.
export function mcpServerSpec(opts: { graphName: string; writeScope?: string }): {
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

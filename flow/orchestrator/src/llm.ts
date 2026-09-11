// llm.ts — the ONE transport layer for single-shot LLM calls (prompt in →
// text out; no tools, no workspace). Installed coding CLIs and API keys are
// BOTH first-class:
//
//   cli  — the user's locally-installed claude CLI (no key needed; a local
//          install will usually never set one)
//   http — any OpenAI-compatible endpoint (LLM_BASE_URL with LLM_API_KEY /
//          OPENROUTER_API_KEY; the headless/EC2 path, where no CLI exists)
//
// LLM_TRANSPORT setting picks: auto (default — CLI when one is installed,
// else key), or force 'cli' / 'http'. Forcing a transport that isn't usable
// surfaces a clear error rather than silently switching — same philosophy as
// INDEXER_RUNTIME. New transports (e.g. a signed-in CLI on a server) slot in
// as another LlmTransportKind; keep that door open.
//
// Features ask for a TIER (fast | smart), not a model — model ids are not
// portable across transports ("claude-haiku-4-5" means nothing to OpenRouter).
// Explicit per-feature overrides (DISTILLER_MODEL etc.) pass through as-is;
// whoever sets one owns matching it to their transport.
//
// Every call logs to llm_log (kind = feature) — classifier-style visibility
// for all callers. Agentic runs (indexer jobs) are NOT this layer: they need
// tools + a workspace and dispatch via resolveIndexerBackend().

import { execFile } from "node:child_process";
import { detectAgents, resolveLocalExecutable } from "./agents/runtime.js";
import { getSetting, llmApiKey, llmBaseUrl } from "./settings.js";
import { logLLM } from "./llmlog.js";

export type LlmTier = "fast" | "smart";
export type LlmTransportKind = "cli" | "http";

export interface LlmCallOpts {
  tier: LlmTier;
  feature: string; // llm_log kind, e.g. "distiller" | "judge"
  model?: string; // explicit override — wins over the tier map, transport-specific id
  timeoutMs?: number;
}

// Per-transport tier defaults. CLI ids match what `claude --model` accepts;
// HTTP ids are the OpenRouter names for the same models (like-for-like).
const CLI_TIER_MODELS: Record<LlmTier, string> = {
  fast: "claude-haiku-4-5",
  smart: "claude-sonnet-4-6",
};
const HTTP_TIER_MODELS: Record<LlmTier, string> = {
  fast: "anthropic/claude-haiku-4.5",
  smart: "anthropic/claude-sonnet-4.6",
};

const DEFAULT_TIMEOUT_MS = 120_000;

// Which transport this process would use right now. null = none usable (no
// CLI installed, no key set) — callers degrade per-feature, they don't crash.
export async function resolveLlmTransport(): Promise<LlmTransportKind | null> {
  const forced = getSetting("LLM_TRANSPORT") ?? "auto";
  if (forced === "cli" || forced === "http") return forced;
  const detected = await detectAgents();
  // Bundled adapters aren't standalone CLIs — only a real executable counts.
  const cli = detected.some((a) => a.id === "claude" && (a.source === "local" || a.source === "explicit"));
  if (cli) return "cli";
  if (llmApiKey()) return "http";
  return null;
}

function modelFor(transport: LlmTransportKind, opts: LlmCallOpts): string {
  if (opts.model) return opts.model;
  const setting = getSetting(opts.tier === "fast" ? "LLM_MODEL_FAST" : "LLM_MODEL_SMART");
  if (setting) return setting;
  return (transport === "cli" ? CLI_TIER_MODELS : HTTP_TIER_MODELS)[opts.tier];
}

async function completeCli(prompt: string, model: string, timeoutMs: number): Promise<string> {
  const bin = (await resolveLocalExecutable("claude")) ?? "claude";
  return await new Promise<string>((resolvePromise, reject) => {
    execFile(
      bin,
      ["-p", prompt, "--model", model, "--output-format", "json"],
      { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const env = JSON.parse(stdout) as { result?: string };
          resolvePromise(typeof env.result === "string" ? env.result : stdout);
        } catch {
          // Not the JSON envelope — return raw stdout (parsers are tolerant).
          resolvePromise(stdout);
        }
      },
    );
  });
}

async function completeHttp(prompt: string, model: string, timeoutMs: number): Promise<string> {
  const apiKey = llmApiKey();
  if (!apiKey) {
    throw new Error("http LLM transport needs an API key — set LLM_API_KEY or OPENROUTER_API_KEY (Settings)");
  }
  const res = await fetch(`${llmBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned an empty response");
  return content;
}

// Single-shot completion through whichever transport is usable. Throws on
// failure or no-transport; callers own their degrade (the distiller skips the
// session, etc.). One attempt — retry policy stays with the caller.
export async function complete(prompt: string, opts: LlmCallOpts): Promise<string> {
  const transport = await resolveLlmTransport();
  if (!transport) {
    throw new Error(
      "no LLM transport available — install a coding CLI (claude) or set LLM_API_KEY/OPENROUTER_API_KEY (Settings)",
    );
  }
  const model = modelFor(transport, opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  try {
    const text =
      transport === "cli"
        ? await completeCli(prompt, model, timeoutMs)
        : await completeHttp(prompt, model, timeoutMs);
    logLLM({ kind: opts.feature, model: `${transport}:${model}`, ok: true, latencyMs: Date.now() - t0, prompt, response: text });
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLLM({ kind: opts.feature, model: `${transport}:${model}`, ok: false, latencyMs: Date.now() - t0, error: msg, prompt });
    throw err;
  }
}

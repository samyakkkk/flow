// settings.ts — DB-backed settings system for the Flow orchestrator.
//
// All runtime config (API keys, intervals, model names) is stored in the
// `config` table under keys `setting:<KEY>`. Secret values are encrypted
// AES-256-GCM with a key scrypt-derived from FLOW_ADMIN_TOKEN (same pattern
// as dashboard/src/lib/localConfig.ts). Only FLOW_ADMIN_TOKEN itself stays
// in .env as bootstrap — everything else can be set from the dashboard.
//
// Precedence: DB value > process.env[key] > registry default.
// Small in-process cache is invalidated on every write.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import db from "./db.js";
import { readGlobalDefault, writeGlobalDefault } from "./global-settings.js";

// ------------------------------------------------------------------
// Setting registry entry
// ------------------------------------------------------------------

export type SettingScope =
  | "classifier"
  | "builder"
  | "poller:linear"
  | "poller:github"
  | "poller:fireflies"
  | "slack"
  | "pipeline"
  | "embeddings";

export interface SettingDef {
  key: string;
  secret: boolean;
  description: string;
  default?: string;
  appliesTo: SettingScope;
}

// ------------------------------------------------------------------
// SETTINGS registry
// ------------------------------------------------------------------

export const SETTINGS: SettingDef[] = [
  {
    key: "OPENROUTER_API_KEY",
    secret: true,
    description: "OpenRouter API key used by the classifier and graph-builder workers",
    appliesTo: "classifier",
  },
  {
    key: "LLM_BASE_URL",
    secret: false,
    description: "OpenAI-compatible API base URL for the classifier and single-shot LLM calls (any provider works). NOTE: embeddings do NOT use this — see EMBEDDING_MODEL / EMBEDDING_API_BASE.",
    default: "https://openrouter.ai/api/v1",
    appliesTo: "classifier",
  },
  {
    key: "LLM_API_KEY",
    secret: true,
    description: "API key for LLM_BASE_URL; when unset, falls back to OPENROUTER_API_KEY",
    appliesTo: "classifier",
  },
  {
    key: "BRAIN_MODE",
    secret: false,
    description:
      "Set to 'opencode' when model access comes from opencode's own provider auth — no API key gate; classifier and embeddings stay off until LLM_API_KEY or OPENROUTER_API_KEY is set",
    appliesTo: "classifier",
  },
  {
    key: "LLM_TRANSPORT",
    secret: false,
    description:
      "Transport for single-shot LLM calls (distiller, judge): auto (installed claude CLI first, else API key), or force 'cli' / 'http'",
    default: "auto",
    appliesTo: "pipeline",
  },
  {
    key: "LLM_MODEL_FAST",
    secret: false,
    description:
      "Overrides the fast-tier model for single-shot LLM calls (judge). Use an id valid for the active transport (CLI alias vs OpenRouter id)",
    appliesTo: "pipeline",
  },
  {
    key: "LLM_MODEL_SMART",
    secret: false,
    description:
      "Overrides the smart-tier model for single-shot LLM calls (distiller). Use an id valid for the active transport (CLI alias vs OpenRouter id)",
    appliesTo: "pipeline",
  },
  {
    key: "CLASSIFIER_MODEL",
    secret: false,
    description: "Model ID passed to OpenRouter for the event classifier",
    default: "minimax/minimax-m3",
    appliesTo: "classifier",
  },
  {
    key: "INDEXER_RUNTIME",
    secret: false,
    description:
      "Which coding CLI runs indexing jobs: auto (first installed of opencode → codex → claude), or force one",
    default: "auto",
    appliesTo: "builder",
  },
  {
    key: "GRAPH_BUILDER_MODEL",
    secret: false,
    description:
      "Overrides the per-backend default model for indexing jobs. A thin or noisy graph is usually fixed by setting this to a stronger model.",
    appliesTo: "builder",
  },
  {
    key: "EMBEDDING_MODEL",
    secret: false,
    description:
      "Which embedding model powers semantic search. Unset = smart default: the local EmbeddingGemma (no key) for dev, or OpenAI text-embedding-3-small when an embedding API key is set. Pick a specific id from the registry to override (e.g. openai:text-embedding-3-large for best quality). Changing this re-embeds the whole graph in the new vector space.",
    appliesTo: "embeddings",
  },
  {
    key: "EMBEDDING_API_KEY",
    secret: true,
    description:
      "API key for API-based embedding models. Falls back to OPENAI_API_KEY, then LLM_API_KEY, then OPENROUTER_API_KEY. The base URL auto-tracks the key's provider: an OpenRouter key (sk-or-…) is sent to OpenRouter's /embeddings endpoint, an OpenAI key to OpenAI. Set EMBEDDING_API_BASE to override.",
    appliesTo: "embeddings",
  },
  {
    key: "EMBEDDING_API_BASE",
    secret: false,
    description:
      "OpenAI-compatible /embeddings base URL for API embedding models. If unset, auto-selects by key provider: OpenRouter (https://openrouter.ai/api/v1) for an sk-or-… key, else OpenAI (https://api.openai.com/v1). Set explicitly for Azure OpenAI or a proxy.",
    appliesTo: "embeddings",
  },
  {
    key: "LINEAR_API_KEY",
    secret: true,
    description: "Linear personal API token for reading/writing issues",
    appliesTo: "poller:linear",
  },
  {
    key: "FIREFLIES_API_KEY",
    secret: true,
    description: "Fireflies API key for polling meeting transcripts",
    appliesTo: "poller:fireflies",
  },
  {
    key: "GITHUB_TOKEN",
    secret: true,
    description: "GitHub personal access token (PAT) for repository polling",
    appliesTo: "poller:github",
  },
  {
    key: "SLACK_BOT_TOKEN",
    secret: true,
    description: "Slack bot OAuth token (xoxb-…) for the Slack agent",
    appliesTo: "slack",
  },
  {
    key: "SLACK_APP_TOKEN",
    secret: true,
    description: "Slack app-level token (xapp-…) for the Slack agent Socket Mode connection",
    appliesTo: "slack",
  },
  {
    key: "FLOW_CONFIDENCE_FLOOR",
    secret: false,
    description: "Confidence threshold below which auto-actions downgrade to propose (0–1)",
    default: "0.75",
    appliesTo: "pipeline",
  },
  {
    key: "FLOW_GITHUB_POLL_MS",
    secret: false,
    description: "GitHub polling interval in milliseconds",
    default: "60000",
    appliesTo: "poller:github",
  },
  {
    key: "FLOW_LINEAR_POLL_MS",
    secret: false,
    description: "Linear polling interval in milliseconds",
    default: "60000",
    appliesTo: "poller:linear",
  },
  {
    key: "FLOW_FIREFLIES_POLL_MS",
    secret: false,
    description: "Fireflies polling interval in milliseconds",
    default: "300000",
    appliesTo: "poller:fireflies",
  },
  {
    key: "FLOW_DM_CHANNEL",
    secret: false,
    description: "Slack channel ID to DM for proposed actions",
    appliesTo: "slack",
  },
];

// Build a lookup map for O(1) access
const SETTINGS_MAP: Map<string, SettingDef> = new Map(
  SETTINGS.map((s) => [s.key, s])
);

export function getSettingDef(key: string): SettingDef | undefined {
  return SETTINGS_MAP.get(key);
}

// ------------------------------------------------------------------
// AES-256-GCM encryption (mirrors dashboard/src/lib/localConfig.ts)
// ------------------------------------------------------------------

const SCRYPT_SALT = "flow-orchestrator-settings-v1";

function derivedKey(): Buffer {
  const token = process.env.FLOW_ADMIN_TOKEN;
  if (!token) {
    throw new Error(
      "FLOW_ADMIN_TOKEN is not set — refusing to encrypt/decrypt settings without an encryption key."
    );
  }
  return scryptSync(token, SCRYPT_SALT, 32);
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const key = derivedKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(stored: string): string | null {
  const parts = stored.split(":");
  if (parts[0] !== "v1" || parts.length !== 4) return null;
  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const key = derivedKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong token or tampered data — fail closed, never return garbage
    return null;
  }
}

// ------------------------------------------------------------------
// DB helpers
// ------------------------------------------------------------------

const DB_PREFIX = "setting:";

function dbKey(settingKey: string): string {
  return `${DB_PREFIX}${settingKey}`;
}

function readRaw(settingKey: string): string | null {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(dbKey(settingKey)) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeRaw(settingKey: string, jsonValue: string): void {
  db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(dbKey(settingKey), jsonValue);
}

function deleteRaw(settingKey: string): void {
  db.prepare("DELETE FROM config WHERE key = ?").run(dbKey(settingKey));
}

// ------------------------------------------------------------------
// In-process cache (invalidated on every write)
// ------------------------------------------------------------------

const _cache = new Map<string, string | undefined>();
let _cacheGeneration = 0;

function invalidateCache(): void {
  _cache.clear();
  _cacheGeneration++;
}

// ------------------------------------------------------------------
// Public read API
// ------------------------------------------------------------------

/**
 * Get a setting value with precedence: DB > process.env > registry default.
 * Returns undefined when none of the three sources has a value.
 */
export function getSetting(key: string): string | undefined {
  if (_cache.has(key)) {
    return _cache.get(key);
  }

  const def = SETTINGS_MAP.get(key);
  let value: string | undefined;

  // 1. DB value
  const raw = readRaw(key);
  if (raw !== null) {
    // raw is JSON-encoded in the config table
    let stored: string;
    try {
      stored = JSON.parse(raw) as string;
    } catch {
      stored = raw;
    }

    if (def?.secret) {
      const plain = decrypt(stored);
      value = plain ?? undefined;
    } else {
      value = stored;
    }
  }

  // 2. process.env fallback
  if (value === undefined && process.env[key] !== undefined) {
    value = process.env[key];
  }

  // 3. Registry default
  if (value === undefined && def?.default !== undefined) {
    value = def.default;
  }

  _cache.set(key, value);
  return value;
}

// Shared resolution for the direct LLM API callers (classifier, embeddings).
// LLM_API_KEY wins; OPENROUTER_API_KEY remains a fallback so existing setups
// keep working. Empty string = no key (callers degrade, they don't crash).
export function llmApiKey(): string {
  return getSetting("LLM_API_KEY") ?? getSetting("OPENROUTER_API_KEY") ?? "";
}

export function llmBaseUrl(): string {
  const base = getSetting("LLM_BASE_URL") ?? "https://openrouter.ai/api/v1";
  return base.replace(/\/+$/, "");
}

/**
 * Return the source of a setting value.
 */
export function getSettingSource(
  key: string
): "db" | "env" | "default" | "unset" {
  const raw = readRaw(key);
  if (raw !== null) {
    // If it's a secret, also check decryption succeeded
    const def = SETTINGS_MAP.get(key);
    if (def?.secret) {
      let stored: string;
      try {
        stored = JSON.parse(raw) as string;
      } catch {
        stored = raw;
      }
      if (decrypt(stored) !== null) return "db";
      // decrypt failed — fall through to env/default
    } else {
      return "db";
    }
  }
  if (process.env[key] !== undefined) return "env";
  const def = SETTINGS_MAP.get(key);
  if (def?.default !== undefined) return "default";
  return "unset";
}

// ------------------------------------------------------------------
// Public write API
// ------------------------------------------------------------------

/**
 * Store a setting value in the DB. Secrets are encrypted.
 * Empty string deletes the DB override (restoring env/default precedence).
 * Invalidates the in-process cache on every call.
 */
export function putSetting(key: string, value: string): void {
  invalidateCache();

  if (value === "") {
    deleteRaw(key);
    return;
  }

  const def = SETTINGS_MAP.get(key);
  let toStore: string;

  if (def?.secret) {
    toStore = encrypt(value);
  } else {
    toStore = value;
  }

  writeRaw(key, JSON.stringify(toStore));
}

// ------------------------------------------------------------------
// GET /v1/settings response shape
// ------------------------------------------------------------------

export type SettingSource = "db" | "env" | "default" | "unset";

export interface SettingView {
  key: string;
  secret: boolean;
  description: string;
  appliesTo: SettingScope;
  source: SettingSource;
  /** Plain value for non-secrets; masked "…last4" for secrets; undefined when unset */
  value: string | undefined;
  set: boolean;
}

function maskSecret(plain: string): string {
  if (plain.length <= 4) return "…" + plain;
  return "…" + plain.slice(-4);
}

/**
 * Build the full settings list for the GET /v1/settings endpoint.
 * Secrets are masked when they have a value; plain text otherwise.
 */
export function listSettings(): SettingView[] {
  return SETTINGS.map((def) => {
    const source = getSettingSource(def.key);
    const raw = getSetting(def.key);
    let value: string | undefined;

    if (raw !== undefined) {
      value = def.secret ? maskSecret(raw) : raw;
    }

    return {
      key: def.key,
      secret: def.secret,
      description: def.description,
      appliesTo: def.appliesTo,
      source,
      value,
      set: raw !== undefined,
    };
  });
}

// ------------------------------------------------------------------
// Audit helper: write a setting_change row without logging the value
// ------------------------------------------------------------------

export function auditSettingChange(key: string): void {
  db.prepare(`
    INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail)
    VALUES (NULL, 'setting_change', 1.0, 'setting_change', ?, 'ok', NULL)
  `).run(key);
}

// ------------------------------------------------------------------
// Route registration
// ------------------------------------------------------------------

import type { FastifyInstance } from "fastify";
import { stopAllPollers, startAllPollers } from "./pollers/engine.js";

export function registerSettingsRoutes(app: FastifyInstance): void {
  // GET /v1/settings — list all settings with masking
  app.get("/v1/settings", async (_req, reply) => {
    return reply.send(listSettings());
  });

  // PUT /v1/settings — bulk update one or more settings
  app.put<{ Body: Record<string, string> }>(
    "/v1/settings",
    async (req, reply) => {
      const body = req.body as Record<string, string>;

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.code(400).send({ error: "Body must be a JSON object of {KEY: value}" });
      }

      const unknown: string[] = [];
      for (const key of Object.keys(body)) {
        if (!SETTINGS_MAP.has(key)) {
          unknown.push(key);
        }
      }
      if (unknown.length > 0) {
        return reply
          .code(400)
          .send({ error: `Unknown setting key(s): ${unknown.join(", ")}` });
      }

      const slackKeys = new Set(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]);
      let slackChanged = false;

      for (const [key, value] of Object.entries(body)) {
        putSetting(key, value);
        auditSettingChange(key);
        // Remember LLM keys as machine defaults so new projects can reuse
        // them instead of re-entering.
        if ((key === "OPENROUTER_API_KEY" || key === "LLM_API_KEY") && value) writeGlobalDefault(key, value);
        if (slackKeys.has(key)) slackChanged = true;
      }

      // Hot-apply: re-init pollers so they pick up new credentials/intervals
      try {
        stopAllPollers();
        // Re-register pollers with fresh intervals from getSetting
        const { reinitPollers } = await import("./bootstrap.js");
        reinitPollers();
        startAllPollers();
      } catch (err) {
        console.error("[settings] reinitPollers error:", err);
      }

      // Hot-apply Slack agent: reconnect with new tokens, or disconnect when
      // the dashboard cleared them (works in local and prod mode alike).
      if (slackChanged) {
        try {
          const { restartSlackAgent } = await import("./slack-agent/boot.js");
          restartSlackAgent().catch((err) =>
            console.error("[settings] Slack agent restart error:", err)
          );
        } catch (err) {
          console.error("[settings] Slack agent import error:", err);
        }
      }

      return reply.send({ ok: true, updated: Object.keys(body) });
    }
  );

  // GET /v1/onboarding/suggested-key — this project has no OpenRouter key yet,
  // but the machine has one saved from another project? Offer it (masked) so
  // the user can reuse instead of re-entering.
  app.get("/v1/onboarding/suggested-key", async () => {
    const KEY = "OPENROUTER_API_KEY";
    if (getSetting(KEY) !== undefined) return { available: false };
    const def = readGlobalDefault(KEY);
    if (!def) return { available: false };
    return { available: true, hint: maskSecret(def) };
  });

  // POST /v1/onboarding/adopt-key — copy the machine default into this project.
  app.post("/v1/onboarding/adopt-key", async (_req, reply) => {
    const KEY = "OPENROUTER_API_KEY";
    const def = readGlobalDefault(KEY);
    if (!def) return reply.code(404).send({ ok: false, error: "No saved key to reuse." });
    putSetting(KEY, def);
    auditSettingChange(KEY);
    return reply.send({ ok: true });
  });
}

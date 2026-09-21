// @effect-diagnostics nodeBuiltinImport:off - Private native-process storage at the Brain host boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { parse, type ParseError } from "jsonc-parser";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function mergeConfig(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeConfig(record(merged[key]), record(value))
        : value;
  }
  return merged;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Carry model/provider configuration, never user plugins, agents, hooks, or MCP servers. */
export function openCodeCuratorConfig(sources: readonly string[]) {
  const config: Record<string, unknown> = {};
  for (const source of sources) {
    const errors: ParseError[] = [];
    const parsed = record(parse(source, errors, { allowTrailingComma: true }));
    if (errors.length)
      throw new Error("Could not read the selected OpenCode provider configuration.");
    for (const key of ["model", "small_model", "enabled_providers", "disabled_providers"])
      if (parsed[key] !== undefined) config[key] = parsed[key];
    // Preserve independent provider entries across global and explicit settings.
    config.provider = mergeConfig(record(config.provider), record(parsed.provider));
  }
  return {
    ...config,
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    plugin: [],
    mcp: {},
    instructions: [],
    permission: { "*": "deny", "t3-code_*": "allow" },
    compaction: { auto: false, prune: false },
  };
}

export interface OpenCodeModelInfo {
  readonly id: string;
  readonly family?: string;
  readonly status?: string;
  readonly release_date?: string;
  readonly capabilities?: { readonly toolcall?: boolean };
}

// The catalogue's inexpensive tier: claude-haiku, gpt-luna, glm-flash, gemini-flash, deepseek-flash.
const LIGHT_FAMILY = /(^|-)(haiku|luna|flash)$/;
const regionOf = (id: string) => /^(us-gov|us|eu|apac|au|jp|ca|global)\./.exec(id)?.[1] ?? "";

/**
 * Notes need a good-enough model, not the user's best one. Stay on the provider and vendor family
 * their own model already proves access to (Bedrock grants access per vendor; a plan serves only
 * its own models) and take that family's newest light sibling: Claude Sonnet becomes Haiku, GLM
 * becomes GLM-Flash. Price cannot rank this: flat-rate plans list every model at zero, and the
 * cheapest metered models are too weak to keep structured notes. No sibling keeps their own model.
 */
export function lightSibling(own: string, models: ReadonlyArray<OpenCodeModelInfo>): string {
  const slash = own.indexOf("/");
  const provider = own.slice(0, slash);
  const ownId = own.slice(slash + 1);
  const family = models.find((model) => model.id === ownId)?.family;
  if (!family || LIGHT_FAMILY.test(family)) return own;
  const vendor = family.split("-")[0];
  const siblings = models.filter(
    (model) =>
      model.family?.split("-")[0] === vendor &&
      LIGHT_FAMILY.test(model.family) &&
      model.capabilities?.toolcall !== false &&
      model.status !== "deprecated",
  );
  // A Bedrock inference profile is regional; keep the one their own model uses.
  const local = siblings.filter((model) => regionOf(model.id) === regionOf(ownId));
  const newest = (local.length ? local : siblings).toSorted((left, right) =>
    (right.release_date ?? "").localeCompare(left.release_date ?? ""),
  )[0];
  return newest ? `${provider}/${newest.id}` : own;
}

/** `opencode models <provider> --verbose` prints a `provider/model` line, then that model's JSON. */
export function parseVerboseModels(stdout: string): OpenCodeModelInfo[] {
  const models: OpenCodeModelInfo[] = [];
  for (const block of stdout.split(/^(?=[^\s{}"[\]]\S*\/\S+$)/m)) {
    const start = block.indexOf("{");
    if (start < 0) continue;
    try {
      const model = record(JSON.parse(block.slice(start)));
      if (typeof model.id === "string") models.push(model as unknown as OpenCodeModelInfo);
    } catch {
      // A model this CLI version prints differently is simply not a candidate.
    }
  }
  return models;
}

async function providerModels(
  binaryPath: string,
  provider: string,
  environment: NodeJS.ProcessEnv,
): Promise<OpenCodeModelInfo[]> {
  try {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      binaryPath,
      ["models", provider, "--verbose"],
      { env: environment, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
    );
    return parseVerboseModels(stdout);
  } catch {
    return []; // Their own model still works without the catalogue.
  }
}

/** What OpenCode last ran is a model this user's subscriptions are known to serve. */
async function lastUsedModel(base: NodeJS.ProcessEnv, home: string): Promise<string | undefined> {
  const state = await readOptional(
    NodePath.join(
      base.XDG_STATE_HOME ?? NodePath.join(home, ".local", "state"),
      "opencode",
      "model.json",
    ),
  );
  if (!state) return undefined;
  try {
    const recent = record((record(JSON.parse(state)).recent as unknown[] | undefined)?.[0]);
    return typeof recent.providerID === "string" && typeof recent.modelID === "string"
      ? `${recent.providerID}/${recent.modelID}`
      : undefined;
  } catch {
    return undefined;
  }
}

export async function prepareOpenCodeCurator(
  base: NodeJS.ProcessEnv,
  options: { binaryPath?: string; chosenModel?: string | undefined } = {},
) {
  const home = base.HOME ?? NodeOS.homedir();
  const configHome = base.XDG_CONFIG_HOME ?? NodePath.join(home, ".config");
  const configDirectory = NodePath.join(configHome, "opencode");
  const paths = ["config.json", "opencode.json", "opencode.jsonc"].map((name) =>
    NodePath.join(configDirectory, name),
  );
  if (base.OPENCODE_CONFIG) paths.push(base.OPENCODE_CONFIG);
  if (base.OPENCODE_CONFIG_DIR)
    paths.push(
      ...["opencode.json", "opencode.jsonc"].map((name) =>
        NodePath.join(base.OPENCODE_CONFIG_DIR!, name),
      ),
    );
  const sources = (await Promise.all(paths.map(readOptional))).filter(
    (text): text is string => text !== undefined,
  );
  if (base.OPENCODE_CONFIG_CONTENT) sources.push(base.OPENCODE_CONFIG_CONTENT);
  const config = openCodeCuratorConfig(sources);
  const authPath = NodePath.join(
    base.XDG_DATA_HOME ?? NodePath.join(home, ".local", "share"),
    "opencode",
    "auth.json",
  );
  const auth = await readOptional(authPath);
  if (
    auth &&
    Object.values(record(JSON.parse(auth))).some((value) => record(value).type === "wellknown")
  )
    throw new Error(
      "OpenCode background extraction cannot inherit remote organization configuration. Use a provider with local credentials.",
    );
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-curator-opencode-"));
  const close = () => NodeFSP.rm(directory, { recursive: true, force: true });
  try {
    const dataHome = NodePath.join(directory, "data");
    await NodeFSP.mkdir(NodePath.join(dataHome, "opencode"), { recursive: true });
    // Share only credentials (including native token refresh), never its session DB.
    if (auth) await NodeFSP.symlink(authPath, NodePath.join(dataHome, "opencode", "auth.json"));
    const environment: NodeJS.ProcessEnv = { ...base };
    for (const key of Object.keys(environment))
      if (key.startsWith("OPENCODE_") && key !== "OPENCODE_API_KEY") delete environment[key];
    Object.assign(environment, {
      HOME: directory,
      USERPROFILE: directory,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: NodePath.join(directory, "config"),
      XDG_CACHE_HOME: NodePath.join(directory, "cache"),
      XDG_STATE_HOME: NodePath.join(directory, "state"),
      OPENCODE_DB: NodePath.join(directory, "opencode.db"),
      OPENCODE_CONFIG_DIR: NodePath.join(directory, "config", "opencode"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_AUTOCOMPACT: "true",
    });
    // Their model, in the order they expressed it: chosen in Flow, configured in OpenCode, last run.
    const configured = record(config).model;
    const own =
      options.chosenModel ??
      (typeof configured === "string" ? configured : await lastUsedModel(base, home));
    const model = own?.includes("/")
      ? lightSibling(
          own,
          await providerModels(options.binaryPath ?? "opencode", own.split("/")[0]!, environment),
        )
      : own;
    return { directory, environment, close, model };
  } catch (error) {
    await close();
    throw error;
  }
}

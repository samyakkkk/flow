// @effect-diagnostics nodeBuiltinImport:off - Private native-process storage at the Brain host boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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

export async function prepareOpenCodeCurator(base: NodeJS.ProcessEnv) {
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
    const model = record(config).model;
    return { directory, environment, close, model: typeof model === "string" ? model : undefined };
  } catch (error) {
    await close();
    throw error;
  }
}

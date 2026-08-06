// lib/materialize.mjs — the materializer: renders Flow's four atoms (hook
// shim wiring, MCP registration, skill, instruction block) into each coding
// tool's config dialect, per repo. See docs/harness-integrations.md §5.
//
// Principles:
//   - Fat/thin split: per-repo files are dumb pointers to ~/.flow/bin/* and
//     never change across Flow versions. The hook LINE is frozen forever
//     (Codex re-requires trust on any definition change).
//   - Idempotent: JSON-merge and marker-splice; our entries are recognized by
//     the flow-hook/flow-mcp path or the flow: markers and replaced in place.
//     Re-running setup repairs drift; --remove restores the repo byte-for-byte
//     (we only ever add whole files or marked blocks).
//   - No secrets in repo files: tokens live in ~/.flow/config.json; repo
//     artifacts carry only --project/--repo names. Safe for `--share`.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  copyFileSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

export const FLOW_DIR = join(homedir(), ".flow");
export const SHIM_PATH = join(FLOW_DIR, "bin", "flow-hook");
export const MCP_PATH = join(FLOW_DIR, "bin", "flow-mcp");
// GUI-launched tools (Cursor, Antigravity, desktop apps) spawn MCP servers and
// hooks with the bare system PATH — no nvm/homebrew — so `#!/usr/bin/env node`
// shebangs fail silently. Bake the absolute node that ran `flow setup`.
export const NODE_BIN = process.execPath;
const MANIFEST_PATH = join(FLOW_DIR, "integrations.json");
export const ATOMS_VERSION = 1; // bump → `flow setup` re-renders repo files

const BLOCK_BEGIN = "<!-- flow:begin — managed by `flow setup`; edits inside are overwritten -->";
const BLOCK_END = "<!-- flow:end -->";
const TOML_BEGIN = "# >>> flow:begin — managed by `flow setup`; edits inside are overwritten >>>";
const TOML_END = "# <<< flow:end <<<";

// ---------------------------------------------------------------------------
// small fs helpers

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

// Splice a marker-delimited block into a text file: replace ours if present,
// else append (with a separating blank line). `begin`/`end` default to the
// markdown markers; TOML files pass comment-style markers.
function spliceBlock(file, content, begin = BLOCK_BEGIN, end = BLOCK_END) {
  const block = `${begin}\n${content.trim()}\n${end}`;
  let text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b >= 0 && e > b) {
    text = text.slice(0, b) + block + text.slice(e + end.length);
  } else {
    text = text.length ? text.replace(/\n*$/, "\n\n") + block + "\n" : block + "\n";
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf-8");
}

function unspliceBlock(file, begin = BLOCK_BEGIN, end = BLOCK_END) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf-8");
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b < 0 || e <= b) return;
  const out = (text.slice(0, b) + text.slice(e + end.length)).replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  if (out.trim() === "") rmSync(file, { force: true });
  else writeFileSync(file, out, "utf-8");
}

// ---------------------------------------------------------------------------
// hooks-object merge (Claude Code dialect, shared by Codex and Gemini)

// Our entries are recognizable forever by the shim path inside the command.
function isFlowHook(entry) {
  return JSON.stringify(entry).includes(".flow/bin/flow-hook");
}

// events: [{name, extra?}] — extra merges into the hook object (e.g. Gemini's
// numeric timeout). cmd(event) renders the frozen hook line.
function mergeHooksObject(existing, events, cmd) {
  const hooks = { ...(existing ?? {}) };
  for (const { name, extra } of events) {
    const kept = (hooks[name] ?? []).filter((entry) => !isFlowHook(entry));
    kept.push({ hooks: [{ type: "command", command: cmd(name), ...(extra ?? {}) }] });
    hooks[name] = kept;
  }
  return hooks;
}

function removeFlowHooks(existing) {
  if (!existing) return existing;
  const out = {};
  for (const [event, arr] of Object.entries(existing)) {
    const kept = (arr ?? []).filter((entry) => !isFlowHook(entry));
    if (kept.length) out[event] = kept;
  }
  return out;
}

// ---------------------------------------------------------------------------
// atom content

function skillMd(project) {
  return `---
name: flow
description: Consult Flow's project memory (knowledge graph + distilled team memory) and store durable conclusions back. Use at session start, when something fails unexpectedly, and before finishing non-trivial work.
---

# Flow project memory

This folder is connected to Flow project **${project}** via the \`flow-graph\` MCP server.

- **Orient first.** At the start of a session, call \`orient\` — it returns what
  this repo is, how it works (distilled from real sessions), and what memory holds.
- **Search on surprise.** Before deep-diving a failure or unfamiliar area, call
  \`search_knowledge\` with the symptom, or \`find_entity\` describing the behavior
  ("the thing that lists git branches") — answers come with file:line anchors.
- **Remember conclusions.** When you finish non-trivial work or the user states a
  durable rule, send it to \`remember\` — verbatim quotes plus enough context to
  stand alone. The distiller files it; you never classify.
- **Skip for trivial edits.** One-line fixes and mechanical changes don't need memory.
`;
}

function instructionBlock(project) {
  return `This repo is connected to Flow project "${project}" — a knowledge graph + team
memory reachable through the \`flow-graph\` MCP tools. Call \`orient\` before
exploring, \`search_knowledge\` when something surprises you, and \`remember\`
for durable conclusions. Details: the "flow" skill.`;
}

// The opencode capture path is a plugin, not a command hook — same shim logic
// as flow-hook, inlined as a ~40-line TS module. Binding is baked; the token
// is NOT: the plugin reads ~/.flow/config.json at post time, so this file is
// safe to commit with --share.
function opencodePlugin(project, repo) {
  return `// flow.ts — Flow capture plugin (managed by \`flow setup\`; regenerated on re-run).
// On session.idle, posts the session's messages to the bound Flow project's
// ingest endpoint. Fail-silent: capture must never break a session.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROJECT = ${JSON.stringify(project)}
const REPO = ${JSON.stringify(repo)}

export const FlowCapture = async ({ client, directory }: any) => {
  if (process.env.FLOW_SESSION_ID) return {} // Flow-run session: already captured
  const post = async (sessionID: string, closed: boolean) => {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), ".flow", "config.json"), "utf8"))
      const p = cfg.projects?.[PROJECT]
      if (!p?.orchestratorUrl) return
      const res: any = await client.session.messages({ path: { id: sessionID } })
      const raw = res?.data ?? res ?? []
      const messages = raw.map((m: any) => ({
        id: m?.info?.id ?? m?.id,
        role: m?.info?.role ?? m?.role,
        parts: (m?.parts ?? []).map((pt: any) => ({ type: pt?.type, text: pt?.text })),
      }))
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2500)
      await fetch(p.orchestratorUrl.replace(/\\/+$/, "") + "/v1/ingest/opencode", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (p.token ?? "") },
        body: JSON.stringify({ sessionID, directory, repo: REPO, messages, closed }),
        signal: ctrl.signal,
      }).catch(() => {})
      clearTimeout(timer)
    } catch {}
  }
  return {
    event: async ({ event }: any) => {
      if (event?.type === "session.idle" && event?.properties?.sessionID) {
        await post(event.properties.sessionID, false)
      }
    },
  }
}
`;
}

// ---------------------------------------------------------------------------
// machine-level: shim + mcp wrapper + config entry

// flow-mcp is generated (not copied): it needs no per-repo state, but it does
// need to exec THIS deployment's gateway MCP with the project's env — all read
// from ~/.flow/config.json at spawn so port drift is fixed by re-running setup.
function mcpWrapperSource() {
  return `#!/usr/bin/env node
// flow-mcp — stdio MCP entry for harnesses (managed by \`flow setup\`).
// Resolves the bound project's gateway MCP + env from ~/.flow/config.json and
// execs it. The registration line in each tool's config never changes.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, execFileSync } from "node:child_process";

const args = {};
for (let i = 2; i < process.argv.length - 1; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i];
}
const cfg = JSON.parse(readFileSync(join(homedir(), ".flow", "config.json"), "utf8"));
const p = cfg.projects?.[args.project];
if (!p) {
  console.error(\`flow-mcp: unknown project "\${args.project}" — re-run: flow setup \${args.project ?? "<name>"}\`);
  process.exit(1);
}
let branch = "";
try {
  branch = execFileSync("git", ["branch", "--show-current"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {}
const env = {
  ...process.env,
  GATEWAY_MCP_READONLY: "1",
  GRAPH_NAME: p.graphName,
  FLOW_REPO: args.repo ?? "",
  FLOW_BRANCH: branch,
  FLOW_MEMORY_URL: p.orchestratorUrl + "/v1/memory/search",
  FLOW_ACTIVITY_URL: p.orchestratorUrl + "/v1/agents/graph-activity",
  FLOW_ACTIVITY_TOKEN: p.token ?? "",
  FLOW_CORRECTIONS_URL: p.orchestratorUrl + "/v1/corrections",
  FLOW_EMBED_URL: p.gatewayUrl + "/v1/embed",
  ...(p.token ? { FLOW_EMBED_TOKEN: p.token } : {}),
  ...(p.falkorHost ? { FALKOR_HOST: p.falkorHost } : {}),
  ...(p.falkorPort ? { FALKOR_PORT: String(p.falkorPort) } : {}),
};
// tsx's bin shim also resolves node via env — make sure OUR node's dir is on
// the child PATH (GUI-spawned parents often carry only the system PATH).
env.PATH = dirname(process.execPath) + ":" + (env.PATH ?? "/usr/bin:/bin");
const child = spawn(p.tsxBin, [p.gatewayMcp], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
`;
}

export function materializeMachine({ flowRoot, projectName, projectEntry, shimSource }) {
  mkdirSync(join(FLOW_DIR, "bin"), { recursive: true });
  copyFileSync(shimSource, SHIM_PATH);
  chmodSync(SHIM_PATH, 0o755);
  writeFileSync(MCP_PATH, mcpWrapperSource(), "utf-8");
  chmodSync(MCP_PATH, 0o755);

  const cfgPath = join(FLOW_DIR, "config.json");
  const cfg = readJson(cfgPath, {});
  cfg.remotes = { ...(cfg.remotes ?? {}), local: { kind: "local", flowRoot } };
  cfg.projects = { ...(cfg.projects ?? {}), [projectName]: projectEntry };
  writeJson(cfgPath, cfg);
}

// ---------------------------------------------------------------------------
// per-tool renderers. Each returns the list of repo-relative paths it wrote
// (whole files it owns; merged files are listed with a `(merged)` suffix in
// the manifest but excluded from --remove deletion).

const HOOK_EVENTS = [
  { name: "SessionStart" },
  { name: "UserPromptSubmit" },
  { name: "Stop" },
  { name: "SessionEnd" },
];

function hookCmd(harness, project, repo) {
  return `"${SHIM_PATH}" --harness ${harness} --project ${project} --repo ${repo} --remote local`;
}

// GUI-app dialect: explicit node, because the shebang can't resolve one on the
// system PATH. Terminal tools keep the plain form — notably Codex, whose hook
// line is trust-hashed and must never change.
function hookCmdGui(harness, project, repo) {
  return `"${NODE_BIN}" ${hookCmd(harness, project, repo)}`;
}

function renderClaude(ctx) {
  const { repoDir, project, repo } = ctx;
  const settingsPath = join(repoDir, ".claude", "settings.json");
  const settings = readJson(settingsPath, {});
  settings.hooks = mergeHooksObject(settings.hooks, HOOK_EVENTS, () => hookCmd("claude", project, repo));
  // Pre-approve the .mcp.json THIS setup writes — the user consented by
  // running `flow setup`; without it every headless/first run drops flow-graph.
  settings.enableAllProjectMcpServers = true;
  // Read-only graph tools are frictionless; writes (remember, correct_graph)
  // keep the harness's own permission prompt.
  const readTools = ["orient", "find_entity", "get_entity", "read_query", "list_schema", "search_knowledge"].map(
    (t) => `mcp__flow-graph__${t}`
  );
  const allow = new Set([...(settings.permissions?.allow ?? []), ...readTools]);
  settings.permissions = { ...(settings.permissions ?? {}), allow: [...allow] };
  writeJson(settingsPath, settings);

  const mcpPath = join(repoDir, ".mcp.json");
  const mcp = readJson(mcpPath, {});
  mcp.mcpServers = {
    ...(mcp.mcpServers ?? {}),
    "flow-graph": { command: NODE_BIN, args: [MCP_PATH, "--project", project, "--repo", repo] },
  };
  writeJson(mcpPath, mcp);

  const skillPath = join(repoDir, ".claude", "skills", "flow", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillMd(project), "utf-8");

  spliceBlock(join(repoDir, "CLAUDE.md"), instructionBlock(project));
  return {
    owned: [".claude/skills/flow/SKILL.md"],
    merged: [".claude/settings.json", ".mcp.json", "CLAUDE.md"],
  };
}

function renderCodex(ctx) {
  const { repoDir, project, repo } = ctx;
  const hooksPath = join(repoDir, ".codex", "hooks.json");
  const hooksFile = readJson(hooksPath, {});
  hooksFile.hooks = mergeHooksObject(hooksFile.hooks, HOOK_EVENTS.map((e) => ({ ...e, extra: { timeout: 5 } })), () =>
    hookCmd("codex", project, repo)
  );
  writeJson(hooksPath, hooksFile);

  // Project-scoped MCP via .codex/config.toml (activates when the project is
  // trusted). Text-spliced managed section — TOML has no safe JSON-style merge.
  const tomlPath = join(repoDir, ".codex", "config.toml");
  spliceBlock(
    tomlPath,
    `[mcp_servers.flow-graph]\ncommand = "${NODE_BIN}"\nargs = ["${MCP_PATH}", "--project", "${project}", "--repo", "${repo}"]`,
    TOML_BEGIN,
    TOML_END
  );

  const skillPath = join(repoDir, ".agents", "skills", "flow", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillMd(project), "utf-8");

  spliceBlock(join(repoDir, "AGENTS.md"), instructionBlock(project));
  return {
    owned: [".agents/skills/flow/SKILL.md"],
    merged: [".codex/hooks.json", ".codex/config.toml", "AGENTS.md"],
  };
}

// Machine-level Codex enablement: hooks feature flag + repo trust. Both are
// additive edits to ~/.codex/config.toml, made only when absent. The /hooks
// trust review itself is interactive — surfaced to the user by `flow setup`.
export function ensureCodexMachineConfig(repoDir, codexHome = join(homedir(), ".codex")) {
  const cfgPath = join(codexHome, "config.toml");
  if (!existsSync(cfgPath)) {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(cfgPath, `[features]\nhooks = true\n\n[projects."${repoDir}"]\ntrust_level = "trusted"\n`, "utf-8");
    return;
  }
  let text = readFileSync(cfgPath, "utf-8");
  if (!/^\s*hooks\s*=\s*true\s*$/m.test(text)) {
    text = /^\[features\]\s*$/m.test(text)
      ? text.replace(/^\[features\]\s*$/m, "[features]\nhooks = true")
      : text.replace(/\n*$/, "\n\n[features]\nhooks = true\n");
  }
  if (!text.includes(`[projects."${repoDir}"]`)) {
    text = text.replace(/\n*$/, `\n\n[projects."${repoDir}"]\ntrust_level = "trusted"\n`);
  }
  writeFileSync(cfgPath, text, "utf-8");
}

function renderOpencode(ctx) {
  const { repoDir, project, repo } = ctx;
  const pluginPath = join(repoDir, ".opencode", "plugins", "flow.ts");
  mkdirSync(dirname(pluginPath), { recursive: true });
  writeFileSync(pluginPath, opencodePlugin(project, repo), "utf-8");

  const ocPath = join(repoDir, "opencode.json");
  const oc = readJson(ocPath, { $schema: "https://opencode.ai/config.json" });
  oc.mcp = {
    ...(oc.mcp ?? {}),
    "flow-graph": { type: "local", command: [NODE_BIN, MCP_PATH, "--project", project, "--repo", repo] },
  };
  writeJson(ocPath, oc);
  // AGENTS.md block shared with Codex — rendered there.
  return { owned: [".opencode/plugins/flow.ts"], merged: ["opencode.json"] };
}

function renderGemini(ctx) {
  const { repoDir, project, repo } = ctx;
  const settingsPath = join(repoDir, ".gemini", "settings.json");
  const settings = readJson(settingsPath, {});
  settings.hooks = mergeHooksObject(
    settings.hooks,
    [
      { name: "SessionStart", extra: { timeout: 5000 } },
      { name: "AfterAgent", extra: { timeout: 5000 } },
      { name: "SessionEnd", extra: { timeout: 5000 } },
    ],
    () => hookCmd("gemini", project, repo)
  );
  settings.mcpServers = {
    ...(settings.mcpServers ?? {}),
    "flow-graph": { command: NODE_BIN, args: [MCP_PATH, "--project", project, "--repo", repo] },
  };
  writeJson(settingsPath, settings);

  spliceBlock(join(repoDir, "GEMINI.md"), instructionBlock(project));
  return { owned: [], merged: [".gemini/settings.json", "GEMINI.md"] };
}

// Cursor hook config dialect differs from the Claude-family shape: flat
// event → [{command}] arrays plus a mandatory version field.
function renderCursor(ctx) {
  const { repoDir, project, repo } = ctx;
  const hooksPath = join(repoDir, ".cursor", "hooks.json");
  const file = readJson(hooksPath, {});
  file.version = 1;
  const hooks = { ...(file.hooks ?? {}) };
  // afterAgentResponse (not stop) carries the assistant text in Cursor's dialect.
  for (const ev of ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "sessionEnd"]) {
    const kept = (hooks[ev] ?? []).filter((e) => !isFlowHook(e));
    kept.push({ command: hookCmdGui("cursor", project, repo) });
    hooks[ev] = kept;
  }
  file.hooks = hooks;
  writeJson(hooksPath, file);

  const mcpPath = join(repoDir, ".cursor", "mcp.json");
  const mcp = readJson(mcpPath, {});
  mcp.mcpServers = {
    ...(mcp.mcpServers ?? {}),
    "flow-graph": { command: NODE_BIN, args: [MCP_PATH, "--project", project, "--repo", repo] },
  };
  writeJson(mcpPath, mcp);

  // Rules: always-on breadcrumb (Cursor reads AGENTS.md too since 2.x, but the
  // .mdc rule is the documented always-apply path).
  const rulePath = join(repoDir, ".cursor", "rules", "flow.mdc");
  mkdirSync(dirname(rulePath), { recursive: true });
  writeFileSync(rulePath, `---\ndescription: Flow project memory\nalwaysApply: true\n---\n\n${instructionBlock(project)}\n`, "utf-8");

  // Cursor discovers skills in .agents/skills/ — the same shared path the
  // Codex renderer writes, so this is a no-op when both are enabled.
  const skillPath = join(repoDir, ".agents", "skills", "flow", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillMd(project), "utf-8");
  return {
    owned: [".cursor/rules/flow.mdc", ".agents/skills/flow/SKILL.md"],
    merged: [".cursor/hooks.json", ".cursor/mcp.json"],
  };
}

function renderAntigravity(ctx) {
  const { repoDir, project, repo } = ctx;
  // Antigravity's dialect: hooks.json maps NAMED GROUPS → event → entries.
  // We own the "flow-capture" group and never touch others.
  const hooksPath = join(repoDir, ".agents", "hooks.json");
  const hooksFile = readJson(hooksPath, {});
  const entry = (name) => [
    { hooks: [{ type: "command", command: hookCmdGui("antigravity", project, repo), timeout: 5 }] },
  ];
  hooksFile["flow-capture"] = { PostInvocation: entry("PostInvocation"), Stop: entry("Stop") };
  writeJson(hooksPath, hooksFile);

  const mcpPath = join(repoDir, ".agents", "mcp_config.json");
  const mcp = readJson(mcpPath, {});
  mcp.mcpServers = {
    ...(mcp.mcpServers ?? {}),
    "flow-graph": { command: NODE_BIN, args: [MCP_PATH, "--project", project, "--repo", repo] },
  };
  writeJson(mcpPath, mcp);
  // Skill dir + AGENTS.md are shared with Codex — rendered there.
  return { owned: [], merged: [".agents/hooks.json", ".agents/mcp_config.json"] };
}

const RENDERERS = {
  claude: renderClaude,
  codex: renderCodex,
  opencode: renderOpencode,
  gemini: renderGemini,
  cursor: renderCursor,
  antigravity: renderAntigravity,
};

export const ALL_HARNESSES = Object.keys(RENDERERS);

// ---------------------------------------------------------------------------
// git exclude + manifest + top-level entry points

function gitExcludePath(repoDir) {
  try {
    const p = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return join(repoDir, p).startsWith("/") && p.startsWith("/") ? p : join(repoDir, p);
  } catch {
    return null;
  }
}

const EXCLUDE_BEGIN = "# >>> flow:begin — `flow setup` personal mode; `flow setup --share` removes >>>";
const EXCLUDE_END = "# <<< flow:end <<<";

function setGitExclude(repoDir, paths, share) {
  const excludeFile = gitExcludePath(repoDir);
  if (!excludeFile) return;
  if (share || paths.length === 0) {
    unspliceBlock(excludeFile, EXCLUDE_BEGIN, EXCLUDE_END);
    return;
  }
  spliceBlock(excludeFile, paths.join("\n"), EXCLUDE_BEGIN, EXCLUDE_END);
}

// Every repo-relative path any renderer may touch — snapshotted before the
// first render so --remove can restore pre-existing files byte-for-byte.
const CANDIDATE_FILES = [
  ".claude/settings.json",
  ".claude/skills/flow/SKILL.md",
  ".mcp.json",
  "CLAUDE.md",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".agents/skills/flow/SKILL.md",
  ".agents/hooks.json",
  ".agents/mcp_config.json",
  "AGENTS.md",
  ".opencode/plugins/flow.ts",
  "opencode.json",
  ".gemini/settings.json",
  "GEMINI.md",
  ".cursor/hooks.json",
  ".cursor/mcp.json",
  ".cursor/rules/flow.mdc",
];
const ORIGINAL_CAP = 256 * 1024;

function snapshotOriginals(repoDir) {
  const manifest = readJson(MANIFEST_PATH, {});
  const repoEntry = manifest.repos?.[repoDir] ?? {};
  const originals = repoEntry.originals ?? {};
  for (const rel of CANDIDATE_FILES) {
    if (originals[rel]) continue; // first-setup snapshot wins; re-runs keep it
    const p = join(repoDir, rel);
    if (existsSync(p)) {
      const buf = readFileSync(p);
      originals[rel] = {
        existed: true,
        data: buf.length <= ORIGINAL_CAP ? buf.toString("base64") : null,
      };
    } else {
      originals[rel] = { existed: false };
    }
  }
  return originals;
}

// A merged config is "semantically empty" when stripping Flow's entries left
// nothing but scaffolding — such files are deleted on --remove if we created
// them, kept (stripped) if the user added their own entries since.
function isEmptyShell(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmptyShell);
  if (typeof v === "object") {
    return Object.entries(v).every(([k, val]) => k === "version" || k === "$schema" || isEmptyShell(val));
  }
  return false;
}

export function materializeRepo(ctx) {
  const harnesses = ctx.harnesses ?? ALL_HARNESSES;
  const originals = snapshotOriginals(ctx.repoDir);
  const owned = [];
  const merged = [];
  for (const h of harnesses) {
    const r = RENDERERS[h](ctx);
    owned.push(...r.owned);
    merged.push(...r.merged);
  }
  if (harnesses.includes("codex")) ensureCodexMachineConfig(ctx.repoDir);

  const all = [...new Set([...owned, ...merged])];
  setGitExclude(ctx.repoDir, all, ctx.share === true);

  const manifest = readJson(MANIFEST_PATH, {});
  manifest.repos = {
    ...(manifest.repos ?? {}),
    [ctx.repoDir]: {
      project: ctx.project,
      repo: ctx.repo,
      harnesses,
      version: ATOMS_VERSION,
      owned,
      merged,
      originals,
      share: ctx.share === true,
      at: new Date().toISOString(),
    },
  };
  writeJson(MANIFEST_PATH, manifest);
  return { owned, merged };
}

export function removeRepo(repoDir) {
  const manifest = readJson(MANIFEST_PATH, {});
  const entry = manifest.repos?.[repoDir];
  const originals = entry?.originals ?? {};
  const owned = entry?.owned ?? [
    ".claude/skills/flow/SKILL.md",
    ".agents/skills/flow/SKILL.md",
    ".opencode/plugins/flow.ts",
    ".cursor/rules/flow.mdc",
  ];
  for (const rel of owned) rmSync(join(repoDir, rel), { force: true });

  // Merged JSON files: strip our entries; marked text files: unsplice.
  for (const rel of [".claude/settings.json", ".gemini/settings.json"]) {
    const p = join(repoDir, rel);
    const j = readJson(p, null);
    if (j?.hooks) {
      j.hooks = removeFlowHooks(j.hooks);
      if (j.mcpServers?.["flow-graph"]) delete j.mcpServers["flow-graph"];
      if (rel.startsWith(".claude")) {
        delete j.enableAllProjectMcpServers;
        if (Array.isArray(j.permissions?.allow)) {
          j.permissions.allow = j.permissions.allow.filter((t) => !String(t).startsWith("mcp__flow-graph__"));
          if (j.permissions.allow.length === 0) delete j.permissions.allow;
          if (isEmptyShell(j.permissions)) delete j.permissions;
        }
      }
      writeJson(p, j);
    }
  }
  const codexHooks = join(repoDir, ".codex", "hooks.json");
  const ch = readJson(codexHooks, null);
  if (ch?.hooks) {
    ch.hooks = removeFlowHooks(ch.hooks);
    writeJson(codexHooks, ch);
  }
  const cursorHooks = join(repoDir, ".cursor", "hooks.json");
  const cu = readJson(cursorHooks, null);
  if (cu?.hooks) {
    for (const [ev, arr] of Object.entries(cu.hooks)) {
      cu.hooks[ev] = arr.filter((e) => !isFlowHook(e));
      if (cu.hooks[ev].length === 0) delete cu.hooks[ev];
    }
    writeJson(cursorHooks, cu);
  }
  for (const rel of [".mcp.json", ".cursor/mcp.json", ".agents/mcp_config.json"]) {
    const p = join(repoDir, rel);
    const j = readJson(p, null);
    if (j?.mcpServers?.["flow-graph"]) {
      delete j.mcpServers["flow-graph"];
      writeJson(p, j);
    }
  }
  const oc = readJson(join(repoDir, "opencode.json"), null);
  if (oc?.mcp?.["flow-graph"]) {
    delete oc.mcp["flow-graph"];
    writeJson(join(repoDir, "opencode.json"), oc);
  }
  const agHooksPath = join(repoDir, ".agents", "hooks.json");
  const agHooks = readJson(agHooksPath, null);
  if (agHooks?.["flow-capture"]) {
    delete agHooks["flow-capture"];
    writeJson(agHooksPath, agHooks);
  }
  for (const f of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) unspliceBlock(join(repoDir, f));
  unspliceBlock(join(repoDir, ".codex", "config.toml"), TOML_BEGIN, TOML_END);
  setGitExclude(repoDir, [], true);

  // Final pass over everything we may have touched: files we CREATED that are
  // now semantically empty get deleted; files that PRE-EXISTED and are now
  // semantically identical to their original get their exact bytes back.
  for (const [rel, orig] of Object.entries(originals)) {
    const p = join(repoDir, rel);
    if (!existsSync(p)) continue;
    if (!orig.existed) {
      const j = readJson(p, undefined);
      const text = readFileSync(p, "utf-8");
      if ((j !== undefined && isEmptyShell(j)) || text.trim() === "") rmSync(p, { force: true });
    } else if (orig.data != null) {
      const originalBuf = Buffer.from(orig.data, "base64");
      const now = readJson(p, undefined);
      const then = (() => {
        try {
          return JSON.parse(originalBuf.toString("utf-8"));
        } catch {
          return undefined;
        }
      })();
      const sameJson = now !== undefined && then !== undefined && JSON.stringify(now) === JSON.stringify(then);
      const sameText = readFileSync(p, "utf-8").trim() === originalBuf.toString("utf-8").trim();
      if (sameJson || sameText) writeFileSync(p, originalBuf);
    }
  }
  // Empty scaffolding dirs left behind are noise — prune best-effort.
  for (const dir of [".claude/skills/flow", ".claude/skills", ".claude", ".codex", ".agents/skills/flow", ".agents/skills", ".agents", ".opencode/plugins", ".opencode", ".gemini", ".cursor/rules", ".cursor"]) {
    try {
      rmdirSync(join(repoDir, dir)); // only succeeds when empty
    } catch {
      /* not empty — keep */
    }
  }

  if (entry) {
    delete manifest.repos[repoDir];
    writeJson(MANIFEST_PATH, manifest);
  }
}

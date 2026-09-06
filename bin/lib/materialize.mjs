import { discoverExecutable } from "./executables.mjs";
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
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseJsonc, modify, applyEdits, createScanner, SyntaxKind, ScanError } from "jsonc-parser";

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

// Copilot's VS Code config accepts comments and trailing commas. Preserve
// those and unrelated settings; malformed config must never be overwritten.
function isJsoncTriviaOnly(text) {
  const scanner = createScanner(text, false);
  for (;;) {
    const token = scanner.scan();
    if (scanner.getTokenError() !== ScanError.None) return false;
    if (token === SyntaxKind.EOF) return true;
    if (
      token !== SyntaxKind.LineCommentTrivia &&
      token !== SyntaxKind.BlockCommentTrivia &&
      token !== SyntaxKind.LineBreakTrivia &&
      token !== SyntaxKind.Trivia
    ) return false;
  }
}

function parseCopilotJson(file, text) {
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if ((errors.length || value == null) && isJsoncTriviaOnly(text)) return {};
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Copilot configuration: ${file}`);
  }
  return value;
}

function tryParseCopilotJson(file, text) {
  try {
    return parseCopilotJson(file, text);
  } catch {
    return undefined;
  }
}

function editCopilotJson(file, edit) {
  let text = existsSync(file) ? readFileSync(file, "utf-8") : "{}\n";
  if (isJsoncTriviaOnly(text)) text = text.trim() ? `{}\n${text}` : "{}\n";
  const value = parseCopilotJson(file, text);
  for (const [path, next] of edit(value)) {
    text = applyEdits(text, modify(text, path, next, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf-8");
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
  return JSON.stringify(entry).replace(/\\+/g, "/").includes(".flow/bin/flow-hook");
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

This repo is documented as connected to Flow project **${project}**.

## How to reach Flow (pick ONE, in this order)

1. If \`flow-graph\` MCP tools are in your tool list → use them:
   \`orient\`, \`search_knowledge\`, \`remember\`, \`find_entity\`.
   If tools are deferred, use your tool discovery/search facility to find
   \`flow-graph orient\` before concluding MCP is unavailable.
2. Only if MCP is unavailable → run the CLI (requires network access from your shell):
   - \`~/.flow/bin/flow orient\`
   - \`~/.flow/bin/flow search "<symptom, identifier, or file path>"\`
   - \`~/.flow/bin/flow remember "<verbatim conclusion + context>"\`

## Trust rules (important)

- The CLI resolves which project this folder belongs to from the machine's own
  registry and prints it in its output header. If it reports a DIFFERENT
  project than **${project}**, or says NOT CONNECTED: **stop using Flow**, tell
  the user to run \`flow setup ${project}\` in this repo, and continue the task
  without memory. Never pass a project name yourself; never guess.
- The MCP orientation labels CONNECTED PROJECT separately from repo. Repository
  names may differ from project names; never treat a repo label as project identity.
  If CONNECTED PROJECT is unavailable, verify the binding with the CLI.
- This skill file alone does not connect a repo. Each person must run
  \`flow setup\` once per repo per machine — that's what installs capture hooks,
  MCP, and the binding.

## When to use it

- **Orient first.** At session start, orient — what this repo is, how it works
  (distilled from real sessions), what memory holds. Re-orient after context loss.
- **Search on surprise.** Before deep-diving a failure or unfamiliar area,
  search the symptom — answers come with file:line anchors.
- **Verify remote references.** If an anchored repository is not cloned here,
  use \`source_read\` or \`source_search\` with its registered repo name and
  relative path/query. Results identify the commit; the default is the indexed
  revision. Never assume a server path exists on this machine.
- **Remember conclusions.** When non-trivial work concludes or the user states a
  durable rule, remember it — verbatim quotes plus enough context to stand
  alone. The distiller files it; you never classify.
- **Skip for trivial edits.** One-line fixes don't need memory.
`;
}

function instructionBlock(project) {
  return `This repo is connected to Flow project "${project}" (knowledge graph + team
memory). Use the \`flow-graph\` MCP tools; discover/search deferred tools for
\`flow-graph orient\` first if needed. Only if MCP is unavailable, use the CLI:
\`~/.flow/bin/flow orient\` at session start, \`… search "<symptom>"\` when
surprised, \`… remember "<conclusion>"\` when durable work concludes. If it
reports a different project or NOT CONNECTED, stop and tell the user to run
\`flow setup ${project}\`. Details: the "flow" skill.`;
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
if (p.mcpUrl) {
  const child = spawn(process.execPath, [p.httpMcpBridge, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("error", () => { console.error("flow-mcp: remote connector could not start; rerun setup"); process.exit(1); });
  child.on("exit", code => process.exit(code ?? 1));
} else {
let branch = "";
try {
  branch = execFileSync("git", ["branch", "--show-current"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {}
const env = {
  ...process.env,
  GATEWAY_MCP_READONLY: "1",
  GRAPH_NAME: p.graphName,
  FLOW_PROJECT_NAME: args.project,
  FLOW_REPO: args.repo ?? "",
  FLOW_BRANCH: branch,
  FLOW_SOURCE_REGISTRY: p.sourceRegistry ?? "",
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
}
`;
}

// The neutral serve CLI: ~/.flow/bin/flow. Deliberately NOT the deployment
// CLI (which users install under arbitrary aliases via setup.sh) — skills and
// instruction blocks are shared between people, so they must reference one
// stable, alias-independent path that `flow setup` guarantees on every
// connected machine. Resolution is from the folder the command runs in,
// against the machine's own binding registry — FAIL-CLOSED: an unbound folder
// gets an instruction to run `flow setup`, never a default project.
export const VERBS_CLI_PATH = join(FLOW_DIR, "bin", "flow");

function verbsCliSource() {
  return `#!/usr/bin/env node
// ~/.flow/bin/flow — Flow memory CLI for agents (managed by \`flow setup\`).
// Subcommands: orient · search "<query>" · remember "<text>" · status
// Binding resolves from the current folder via ~/.flow/integrations.json.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const FLOW_DIR = join(homedir(), ".flow");
const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

function resolveBinding() {
  const manifest = read(join(FLOW_DIR, "integrations.json"));
  const repos = manifest?.repos ?? {};
  let dir = process.cwd();
  for (;;) {
    if (repos[dir]) return { repoDir: dir, ...repos[dir] };
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

async function call(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
  return res.json();
}

const cmd = process.argv[2];
const arg = process.argv.slice(3).join(" ").trim();

if (!cmd || !["orient", "search", "remember", "status"].includes(cmd)) {
  console.log('usage: flow orient | flow search "<query>" | flow remember "<text>" | flow status');
  process.exit(0);
}

const binding = resolveBinding();
if (!binding) {
  console.log(
    "NOT CONNECTED: this folder has no Flow binding on this machine.\\n" +
      "Skill/instruction files alone do not connect a repo — hooks, MCP and the\\n" +
      "project binding come from running setup once, per person, per machine.\\n" +
      "→ Tell the user to run:  flow setup <project>  in this repository.\\n" +
      "Do not guess a project. Proceed without Flow memory for now."
  );
  process.exit(2);
}

const cfg = read(join(FLOW_DIR, "config.json"));
const p = cfg?.projects?.[binding.project];
if (!p) {
  console.log(\`NOT CONNECTED: binding says project "\${binding.project}" but that project is not configured on this machine. Tell the user to re-run: flow setup \${binding.project}\`);
  process.exit(2);
}

let branch = "";
try {
  branch = execFileSync("git", ["branch", "--show-current"], { cwd: binding.repoDir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {}

const header = \`[flow · project "\${binding.project}" · repo "\${binding.repo}" · resolved from \${binding.repoDir}]
If this project does not match what this repo's instructions/skill document, STOP and tell the user to re-run: flow setup <correct-project>.\`;

try {
  if (cmd === "status") {
    console.log(header);
  } else if (cmd === "orient") {
    const text = await call(p.gatewayUrl + "/v1/verbs/orient", p.token, { repo: binding.repo, branch, graph: p.graphName });
    console.log(header + "\\n\\n" + (typeof text === "string" ? text : JSON.stringify(text, null, 2)));
  } else if (cmd === "search") {
    if (!arg) { console.log('usage: flow search "<query>"'); process.exit(0); }
    const out = await call(p.orchestratorUrl + "/v1/memory/search", p.token, { query: arg, repo: binding.repo });
    // lines is a rendered string today; stay tolerant of array/absent shapes.
    const text = Array.isArray(out.lines)
      ? out.lines.join("\\n")
      : typeof out.lines === "string" && out.lines.trim()
        ? out.lines
        : JSON.stringify(out, null, 2);
    console.log(header + "\\n\\n" + text);
  } else if (cmd === "remember") {
    if (!arg) { console.log('usage: flow remember "<text — verbatim quotes plus context>"'); process.exit(0); }
    const out = await call(p.orchestratorUrl + "/v1/memory/remember", p.token, { text: arg, repo: binding.repo, branch });
    console.log(header + "\\n\\nSent to Flow's memory (" + (out.status ?? "ok") + ") — the distiller files it; nothing else to do.");
  }
} catch (e) {
  console.log(header + "\\n\\nFLOW UNAVAILABLE: " + (e?.message ?? e) + "\\nProceed without Flow memory; mention to the user that the Flow deployment looks unreachable.");
  process.exit(0); // never fail the agent's shell step
}
`;
}

export function materializeMachine({ flowRoot, projectName, projectEntry, shimSource }) {
  mkdirSync(join(FLOW_DIR, "bin"), { recursive: true });
  copyFileSync(shimSource, SHIM_PATH);
  chmodSync(SHIM_PATH, 0o755);
  writeFileSync(MCP_PATH, mcpWrapperSource(), "utf-8");
  chmodSync(MCP_PATH, 0o755);
  writeFileSync(VERBS_CLI_PATH, verbsCliSource(), "utf-8");
  chmodSync(VERBS_CLI_PATH, 0o755);

  const cfgPath = join(FLOW_DIR, "config.json");
  const cfg = readJson(cfgPath, {});
  cfg.remotes = { ...(cfg.remotes ?? {}), local: { kind: "local", flowRoot } };
  cfg.projects = { ...(cfg.projects ?? {}), [projectName]: projectEntry };
  writeJson(cfgPath, cfg);
  chmodSync(cfgPath, 0o600);
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
  const readTools = ["orient", "find_entity", "get_entity", "read_query", "list_schema", "search_knowledge", "source_read", "source_search"].map(
    (t) => `mcp__flow-graph__${t}`
  );
  // The CLI fallback path gets the same frictionless treatment as MCP reads.
  readTools.push(`Bash(${VERBS_CLI_PATH}:*)`, "Bash(~/.flow/bin/flow:*)");
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
  hooksFile.hooks = mergeHooksObject(hooksFile.hooks, HOOK_EVENTS.map((e) => ({ ...e, extra: { timeout: e.name === "SessionEnd" ? 3 : 5 } })), () =>
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

function renderSharedKnowledge({ repoDir, project }) {
  const skillPath = join(repoDir, ".agents", "skills", "flow", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillMd(project), "utf-8");
  spliceBlock(join(repoDir, "AGENTS.md"), instructionBlock(project));
  return { owned: [".agents/skills/flow/SKILL.md"], merged: ["AGENTS.md"] };
}

function renderOpencode(ctx) {
  const { repoDir, project, repo } = ctx;
  // Keep OpenCode's dependency installer from walking into the parent repo.
  // Existing user manifests belong to the user and are never rewritten here.
  const packageRel = ".opencode/package.json";
  const packagePath = join(repoDir, packageRel);
  const ownPackage = !existsSync(packagePath) ||
    (readJson(MANIFEST_PATH, {}).repos?.[repoDir]?.owned ?? []).includes(packageRel);
  if (!existsSync(packagePath)) writeJson(packagePath, {
    private: true, dependencies: { "@opencode-ai/plugin": "1.17.20" },
  });
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
  const knowledge = renderSharedKnowledge(ctx);
  return { owned: [".opencode/plugins/flow.ts", ...(ownPackage ? [packageRel] : []), ...knowledge.owned], merged: ["opencode.json", ...knowledge.merged] };
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
  const knowledge = renderSharedKnowledge(ctx);
  return { owned: knowledge.owned, merged: [".gemini/settings.json", "GEMINI.md", ...knowledge.merged] };
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

function isAntigravityFlowServer(name, server) {
  return (name === "flow-graph" || name.startsWith("flow-graph-")) &&
    (server?.command === MCP_PATH || (Array.isArray(server?.args) && server.args.includes(MCP_PATH)));
}

function renderAntigravity(ctx) {
  const { repoDir, project, repo } = ctx;
  // Antigravity's dialect: hooks.json maps NAMED GROUPS → event → entries.
  // We own the "flow-capture" group and never touch others.
  const hooksPath = join(repoDir, ".agents", "hooks.json");
  const hooksFile = readJson(hooksPath, {});
  // Lifecycle events use flat handlers; only tool events use matcher/groups.
  const entry = (name) => [
    { type: "command", command: `${hookCmdGui("antigravity", project, repo)} --event ${name}`, timeout: 5 },
  ];
  hooksFile["flow-capture"] = { PostInvocation: entry("PostInvocation"), Stop: entry("Stop") };
  writeJson(hooksPath, hooksFile);

  const mcpPath = join(repoDir, ".agents", "mcp_config.json");
  const mcp = readJson(mcpPath, {});
  // Antigravity pools MCP connections by name across open projects. Reusing
  // flow-graph can route a new workspace to an earlier project's process.
  const name = `flow-graph-${createHash("sha256").update(JSON.stringify([project, repo])).digest("hex").slice(0, 12)}`;
  const servers = { ...(mcp.mcpServers ?? {}) };
  for (const [key, server] of Object.entries(servers)) {
    if (isAntigravityFlowServer(key, server)) delete servers[key];
  }
  servers[name] = { command: NODE_BIN, args: [MCP_PATH, "--project", project, "--repo", repo] };
  mcp.mcpServers = servers;
  writeJson(mcpPath, mcp);
  const knowledge = renderSharedKnowledge(ctx);
  return { owned: knowledge.owned, merged: [".agents/hooks.json", ".agents/mcp_config.json", ...knowledge.merged] };
}

const COPILOT_JSON_FILES = [".github/hooks/flow.json", ".github/mcp.json", ".vscode/mcp.json"];

function renderCopilot(ctx) {
  const { repoDir, project, repo } = ctx;
  const argv = [NODE_BIN, SHIM_PATH, "--harness", "copilot", "--project", project, "--repo", repo, "--remote", "local"];
  const command = process.platform === "win32"
    ? "& " + argv.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")
    : argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
  // PascalCase selects the VS Code-compatible payload dialect in Copilot CLI.
  // SessionEnd is CLI-only; VS Code sessions are distilled by the idle sweep.
  editCopilotJson(join(repoDir, COPILOT_JSON_FILES[0]), (file) => [
    [["version"], 1],
    ...HOOK_EVENTS.map(({ name }) => [["hooks", name], [
      ...(file.hooks?.[name] ?? []).filter((entry) => !isFlowHook(entry)),
      { type: "command", command, timeout: 5 },
    ]]),
  ]);

  for (const rel of COPILOT_JSON_FILES.slice(1)) {
    editCopilotJson(join(repoDir, rel), (file) => {
      const key = rel.startsWith(".vscode") ? "servers" : "mcpServers";
      // CLI also accepts a bare map of server names.
      const path = key === "mcpServers" && !file.mcpServers && Object.keys(file).some((k) => k !== "$schema")
        ? ["flow-graph"] : [key, "flow-graph"];
      return [[path, { type: "stdio", command: NODE_BIN, args: [MCP_PATH, "--project", project, "--repo", repo] }]];
    });
  }

  const skillPath = join(repoDir, ".github/skills/flow/SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillMd(project), "utf-8");
  spliceBlock(join(repoDir, ".github/copilot-instructions.md"), instructionBlock(project));
  return {
    owned: [".github/skills/flow/SKILL.md"],
    merged: [...COPILOT_JSON_FILES, ".github/copilot-instructions.md"],
  };
}

const RENDERERS = {
  claude: renderClaude,
  codex: renderCodex,
  opencode: renderOpencode,
  gemini: renderGemini,
  cursor: renderCursor,
  antigravity: renderAntigravity,
  copilot: renderCopilot,
};

export const ALL_HARNESSES = Object.keys(RENDERERS);

// Which tools does this machine actually have? Default `flow setup` renders
// only these — configuring a tool the user never installed is mostly inert
// but does leave real cruft (a ~/.codex dir, trust entries). `--all`
// force-renders everything (pre-wiring for tools installed later).
function onPath(bin) {
  return discoverExecutable(bin) !== null;
}

export function detectHarnesses() {
  const home = homedir();
  const checks = {
    claude: () => onPath("claude") || existsSync(join(home, ".claude", "settings.json")),
    codex: () => onPath("codex") || existsSync(join(home, ".codex", "config.toml")),
    opencode: () =>
      onPath("opencode") || existsSync(join(home, ".opencode")) || existsSync(join(home, ".config", "opencode")),
    gemini: () => onPath("gemini") || existsSync(join(home, ".gemini", "settings.json")),
    cursor: () => existsSync("/Applications/Cursor.app") || existsSync(join(home, ".cursor")),
    antigravity: () =>
      existsSync("/Applications/Antigravity.app") ||
      existsSync("/Applications/Antigravity IDE.app") ||
      existsSync(join(home, ".gemini", "antigravity")),
    copilot: () => onPath("copilot") || existsSync(process.env.COPILOT_HOME || join(home, ".copilot")) ||
      [".vscode", ".vscode-insiders", ".vscode-server"].some((dir) => {
        try {
          return readdirSync(join(home, dir, "extensions")).some((name) => /^github\.copilot(?:-chat)?-/i.test(name));
        } catch { return false; }
      }),
  };
  return ALL_HARNESSES.filter((h) => {
    try {
      return checks[h]();
    } catch {
      return false;
    }
  });
}

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
  ".opencode/package.json",
  ".gemini/settings.json",
  "GEMINI.md",
  ".cursor/hooks.json",
  ".cursor/mcp.json",
  ".cursor/rules/flow.mdc",
  ...COPILOT_JSON_FILES,
  ".github/skills/flow/SKILL.md",
  ".github/copilot-instructions.md",
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
  // Setup is additive. A later --harness codex must not expose previously
  // hidden Copilot files or forget how to remove them. Re-render prior tools
  // too so changing the binding never leaves stale project credentials in use.
  const previous = readJson(MANIFEST_PATH, {}).repos?.[ctx.repoDir];
  const harnesses = [...new Set([...(previous?.harnesses ?? []), ...(ctx.harnesses ?? ALL_HARNESSES)])];
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
    ".github/skills/flow/SKILL.md",
  ];
  for (const rel of owned) {
    if (originals[rel]?.existed && originals[rel].data != null) {
      writeFileSync(join(repoDir, rel), Buffer.from(originals[rel].data, "base64"));
    } else rmSync(join(repoDir, rel), { force: true });
  }

  for (const rel of COPILOT_JSON_FILES) {
    if (entry && !entry.merged?.includes(rel)) continue;
    const p = join(repoDir, rel);
    if (!existsSync(p)) continue;
    const original = originals[rel]?.data
      ? parseCopilotJson(`${p} (original)`, Buffer.from(originals[rel].data, "base64").toString("utf8")) : {};
    editCopilotJson(p, (file) => {
      if (rel.endsWith("hooks/flow.json")) {
        const hooks = removeFlowHooks(file.hooks);
        return hooks ? [
          [["hooks"], Object.keys(hooks).length || original.hooks ? hooks : undefined],
          [["version"], original.version ?? (originals[rel]?.existed ? undefined : file.version)],
        ] : [];
      }
      const key = rel.startsWith(".vscode") ? "servers" : "mcpServers";
      if (file[key]?.["flow-graph"]) {
        const servers = { ...file[key] };
        delete servers["flow-graph"];
        return Object.keys(servers).length || original[key] ? [[[key, "flow-graph"], undefined]] : [[[key], undefined]];
      }
      return file["flow-graph"] ? [[["flow-graph"], undefined]] : [];
    });
  }

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
    if (rel === ".agents/mcp_config.json" && j?.mcpServers) {
      for (const [name, server] of Object.entries(j.mcpServers)) {
        if (isAntigravityFlowServer(name, server)) delete j.mcpServers[name];
      }
      writeJson(p, j);
    } else if (j?.mcpServers?.["flow-graph"]) {
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
  for (const f of ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".github/copilot-instructions.md"]) unspliceBlock(join(repoDir, f));
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
      const now = COPILOT_JSON_FILES.includes(rel) ? tryParseCopilotJson(p, readFileSync(p, "utf-8")) : readJson(p, undefined);
      const then = (() => {
        try {
          return COPILOT_JSON_FILES.includes(rel) ? tryParseCopilotJson(`${p} (original)`, originalBuf.toString("utf-8")) : JSON.parse(originalBuf.toString("utf-8"));
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
  for (const dir of [".claude/skills/flow", ".claude/skills", ".claude", ".codex", ".agents/skills/flow", ".agents/skills", ".agents", ".opencode/plugins", ".opencode", ".gemini", ".cursor/rules", ".cursor", ".github/skills/flow", ".github/skills", ".github/hooks", ".github", ".vscode"]) {
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

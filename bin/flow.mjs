#!/usr/bin/env node
// flow.mjs — Flow multi-project CLI.
//
// Commands:
//   flow project create <name> [--graph <g>] [--mode local|prod]
//   flow up [name]
//   flow down [name]
//   flow ls
//   flow --help

import { parseArgs } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  rmSync,
  openSync,
  closeSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, basename } from "node:path";
import { hostname, homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";

import { portsForIndex, dashboardPort } from "./lib/ports.mjs";
import {
  flowRoot,
  projectDir,
  projectJsonPath,
  pidsJsonPath,
  projectsRoot,
  gatewayDir,
  orchestratorDir,
  dashboardDir,
  indexWorkspaceDir,
} from "./lib/paths.mjs";
import {
  readProject,
  writeProject,
  listProjectNames,
  listProjects,
  readPids,
  writePids,
} from "./lib/projects.mjs";
import { probe, waitForHealth } from "./lib/health.mjs";
import {
  materializeMachine,
  materializeRepo,
  removeRepo,
  ALL_HARNESSES,
  detectHarnesses,
} from "./lib/materialize.mjs";
import { ensureFalkordb } from "./lib/docker.mjs";
import { clearGraphTombstone, deleteProjectGraph } from "./lib/falkordb.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`\n${c.red("✗")} ${msg}\n`);
  process.exit(1);
}

// ── Pretty output ────────────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint("1"),
  dim: paint("2"),
  green: paint("32"),
  red: paint("31"),
  yellow: paint("33"),
  cyan: paint("36"),
};
const OK = c.green("✓");
const FAIL = c.red("✗");

// Yes/no prompt. Non-interactive (no TTY) → false: never take a creative or
// destructive action when there's no human to confirm.
async function confirm(question, defaultYes = true) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`${question} ${c.dim(defaultYes ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
  rl.close();
  if (ans === "") return defaultYes;
  return ans === "y" || ans === "yes";
}

function printHelp() {
  console.log(`
${c.bold("flow")} — run Flow projects (knowledge graph + coding agents)

${c.bold("Usage")}
  flow up [name]        Start a project (creates it if new). No name = all projects.
  flow down [name]      Stop a project. No name = all.
  flow ls               List projects, status, and dashboard URLs.
  flow doctor           Health-check every project — pages load, assets load, services up.
  flow rm <name>        Stop and delete a project and its data.
  flow connect <url>    Connect this machine to a deployed Flow (device flow → token).
  flow remotes          List connected deployments (remove with: flow remotes remove <name>).
  flow setup <name>     Connect the current git repo to a project: installs Flow's
                        capture hooks, MCP registration, skill, and instruction blocks
                        into every coding tool's config (Claude Code, Codex, opencode,
                        Gemini CLI, Cursor, Antigravity). Idempotent; re-run to repair.
     --share            Un-hide the written files from git so the team can commit them
                        (default: personal mode via .git/info/exclude).
     --harness a,b      Limit to specific tools.
     --remove           Uninstall Flow artifacts from this repo.

${c.bold("Options")}
  --mode local|prod     For a new project (default: local). Local needs no login.

${c.bold("Examples")}
  flow up acme          ${c.dim("# start acme — offers to create it if it doesn't exist")}
  flow up               ${c.dim("# start everything")}
  flow ls
  flow down
`);
}

// ── Parse env file (KEY=VALUE, ignores comments, blank lines) ────────────────

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  const lines = readFileSync(filePath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// The OpenRouter key powers the gateway's semantic find_entity + embed-on-write.
// It usually isn't in the project .env — it's saved once as a machine default in
// <data>/global.json (see orchestrator/src/global-settings.ts). Read it from
// there so the gateway gets the same key everything else uses. projectDir is
// <data>/projects/<name>, so ../../global.json is <data>/global.json.
function readGlobalKey(projectDir, key) {
  try {
    const p = join(projectDir, "..", "..", "global.json");
    if (!existsSync(p)) return undefined;
    const v = JSON.parse(readFileSync(p, "utf-8"))?.[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

// ── Self-update ──────────────────────────────────────────────────────────────
//
// `flow up` fast-forwards the checkout before starting services, so "update
// flow" is just "flow up" — migrations and reconcilers run at service boot
// with the new code. Deliberately conservative: ff-only, and skipped entirely
// when this looks like a dev checkout (dirty worktree or non-default branch),
// when offline, or when opted out (--no-update / FLOW_NO_UPDATE=1). An update
// failure never blocks boot.
//
// After a successful pull the CLI re-execs itself (with updates disabled) so
// the rest of the invocation runs the NEW cli code too — otherwise this
// process would keep executing the old flow.mjs from memory while spawning
// new-source services.

function maybeSelfUpdate() {
  if (process.env.FLOW_NO_UPDATE === "1") return;
  if (!existsSync(join(flowRoot, ".git"))) return; // not a git install

  const git = (args, timeout = 15000) =>
    spawnSync("git", args, { cwd: flowRoot, encoding: "utf8", timeout });

  const branch = (git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout ?? "").trim();
  if (branch !== "main" && branch !== "master") return; // dev checkout on a feature branch
  if ((git(["status", "--porcelain"]).stdout ?? "").trim()) return; // dirty — dev checkout
  if (git(["rev-parse", "--abbrev-ref", "@{u}"]).status !== 0) return; // no upstream

  if (git(["fetch", "--quiet"], 10000).status !== 0) return; // offline / remote unreachable
  const behind = Number((git(["rev-list", "--count", "HEAD..@{u}"]).stdout ?? "0").trim());
  if (!behind) return;

  const oldHead = (git(["rev-parse", "--short", "HEAD"]).stdout ?? "").trim();
  const lockBefore = (git(["rev-parse", "HEAD:package-lock.json"]).stdout ?? "").trim();
  if (git(["pull", "--ff-only", "--quiet"], 60000).status !== 0) {
    console.log(c.dim("  update available but not fast-forwardable — skipped (git pull manually)"));
    return;
  }
  const newHead = (git(["rev-parse", "--short", "HEAD"]).stdout ?? "").trim();
  console.log(`  ${OK} flow updated ${c.dim(`${oldHead} → ${newHead} (${behind} commit${behind === 1 ? "" : "s"})`)}`);

  const lockAfter = (git(["rev-parse", "HEAD:package-lock.json"]).stdout ?? "").trim();
  if (lockBefore !== lockAfter) {
    console.log(c.dim("  dependencies changed — running npm install…"));
    const res = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: flowRoot,
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 300000,
    });
    if (res.status !== 0) {
      console.log(`  ${FAIL} npm install failed — continuing with existing deps (run it manually if boot fails)`);
    }
  }

  // Re-exec the updated CLI; FLOW_NO_UPDATE stops recursion.
  const child = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, FLOW_NO_UPDATE: "1" },
  });
  process.exit(child.status ?? 0);
}

// Commit the running code identifies as. Services load source at spawn (tsx),
// so `flow up` compares this against the stamp written when a project's
// services started to decide whether "already running" is good enough or the
// code moved underneath them (self-update, branch switch) and they must
// restart to pick up migrations/reconcilers. null on non-git installs.
function codeHead() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: flowRoot, encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? (r.stdout ?? "").trim() || null : null;
}

// ── Pid / process state helpers ──────────────────────────────────────────────

/** Return true if a process with the given pid is alive. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Spawn a service, returning the child pid ─────────────────────────────────

/**
 * Spawn a long-running service, detached, writing stdout+stderr to logFile.
 * Returns the child pid.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string[]} opts.cmd
 * @param {Record<string,string>} opts.env
 * @param {string} opts.logFile  Absolute path to log file
 */
// Build the dashboard once for all projects (next start shares one build).
// Rebuilds only when dashboard/src is newer than the existing BUILD_ID.
function ensureDashboardBuild() {
  const dir = dashboardDir();
  const buildIdFile = join(dir, ".next", "BUILD_ID");
  const newestSrcMtime = (d) => {
    let newest = 0;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const p = join(d, entry.name);
      newest = Math.max(newest, entry.isDirectory() ? newestSrcMtime(p) : statSync(p).mtimeMs);
    }
    return newest;
  };
  let stale = true;
  try {
    stale = newestSrcMtime(join(dir, "src")) > statSync(buildIdFile).mtimeMs;
  } catch {
    // no build yet
  }
  if (!stale) return false;
  // Guard a recurring footgun: if a prior `npm install` ran with
  // NODE_ENV=production, build-only devDeps (e.g. @tailwindcss/postcss) get
  // pruned, and `next build` then fails — historically with a misleading
  // "Cannot find @tailwindcss/postcss", or worse, a silently degraded build
  // (empty middleware, broken /_global-error). Detect it, auto-remediate once
  // with devDeps forced in, and fail with a precise message if we still can't.
  const req = createRequire(join(dir, "package.json"));
  const devDepsMissing = () => {
    try { req.resolve("@tailwindcss/postcss"); return false; }
    catch { return true; }
  };
  if (devDepsMissing()) {
    console.log(c.dim("  build devDeps pruned (NODE_ENV=production install?) — reinstalling with devDeps…"));
    spawnSync("npm", ["install", "--include=dev", "--no-audit", "--no-fund"], {
      cwd: join(dir, ".."),
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, NODE_ENV: "" },
    });
    if (devDepsMissing()) {
      throw new Error(
        "dashboard build devDeps missing (@tailwindcss/postcss): a prior `npm install` under NODE_ENV=production pruned them. Fix: `NODE_ENV= npm install --include=dev` in the repo root.",
      );
    }
  }
  console.log(c.dim("  building dashboard (first run ~30s)…"));
  const res = spawnSync(nodeBin(dir, "next"), ["build"], {
    cwd: dir,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (res.status !== 0) throw new Error("dashboard build failed — run `npm run build` in dashboard/ to see why");
  return true; // rebuilt — callers must restart running dashboards (shared .next)
}

// Is anything listening on a TCP port? Deterministic (unlike a health probe
// that can flake and trick us into starting a second process on a used port).
function portInUse(port) {
  // Fast path: lsof (present on macOS + most Linux). spawnSync does NOT throw
  // when lsof is missing — it returns { error, status: null } — so distinguish
  // "lsof ran" from "lsof absent" explicitly. Reading a missing lsof as "port
  // free" makes `flow up` spawn a DUPLICATE on a live port (EADDRINUSE) — which
  // is exactly what happened in the container (node:22 ships no lsof).
  const r = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (!r.error && r.status !== null) {
    return (r.stdout ?? "").trim().length > 0;
  }
  // lsof absent — node-native TCP connect probe: a successful connect to
  // 127.0.0.1:port means something is listening there.
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const s=require('net').connect(${port},'127.0.0.1');` +
        `s.on('connect',()=>{s.destroy();process.exit(0)});` +
        `s.on('error',()=>process.exit(3));` +
        `setTimeout(()=>{s.destroy();process.exit(3)},800);`,
    ],
    { encoding: "utf8", timeout: 2000 },
  );
  return probe.status === 0;
}

// Kill whatever holds a TCP port (best-effort).
function killPort(port) {
  try {
    const out = (spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "").trim();
    for (const p of out.split("\n").filter(Boolean)) {
      try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ }
    }
  } catch { /* lsof missing */ }
}

// ── Deployment-level state (data/): auth store + the singleton dashboard ────
//
// Since the single-dashboard refactor, ONE dashboard on dashboardPort()
// serves every project under /p/<name>/…. It reads the project registry
// (data/projects/*) per request, so new projects appear without a restart.

function dataDir() {
  return join(flowRoot, "data");
}

function authJsonPath() {
  return join(dataDir(), "auth.json");
}

// The deployment is prod if ANY project is prod — an exposed box needs real
// accounts even if a local-mode project also lives on it.
function deploymentMode() {
  return listProjects().some(({ project }) => project.mode === "prod") ? "prod" : "local";
}

// Create/upgrade data/auth.json (idempotent, convergent on every boot — same
// philosophy as the gateway's reconcilers). In prod with no accounts yet, a
// one-time setup code gates the "create owner" form; we print it so the
// person at the terminal — and only them — can claim the deployment.
function ensureAuthStore(mode) {
  mkdirSync(dataDir(), { recursive: true });
  let store = null;
  if (existsSync(authJsonPath())) {
    try {
      store = JSON.parse(readFileSync(authJsonPath(), "utf-8"));
    } catch {
      store = null; // corrupt — rebuild below, prod users would re-bootstrap
    }
  }
  if (!store || typeof store !== "object" || !store.sessionSecret) {
    store = {
      version: 1,
      sessionSecret: randomBytes(24).toString("hex"),
      users: [],
      grants: {},
      tokens: [],
    };
  }
  store.users ??= [];
  store.grants ??= {};
  store.tokens ??= [];
  // Stable identity for this deployment, independent of its URL/IP. A team can
  // move the box, change the DNS name, or get a new EC2 IP — the deploymentId
  // stays constant, so a machine reconnecting to the new address updates its
  // existing remote in place instead of forking a duplicate. Minted once.
  store.deploymentId ??= randomUUID();
  let setupToken = null;
  if (mode === "prod" && store.users.length === 0) {
    store.setupToken ??= randomBytes(4).toString("hex");
    setupToken = store.setupToken;
  }
  writeFileSync(authJsonPath(), JSON.stringify(store, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  return { setupToken };
}

function writeDashboardPid(pid) {
  writeFileSync(join(dataDir(), "dashboard.json"), JSON.stringify({ pid, port: dashboardPort() }, null, 2) + "\n", "utf-8");
}

// (Re)start THE dashboard against the current shared build. Kills any stale
// process on the port first so a rebuild can't leave it serving dead chunk
// hashes (the "unstyled page" bug).
function spawnDashboard(mode) {
  const port = dashboardPort();
  mkdirSync(join(dataDir(), "logs"), { recursive: true });
  const dashEnv = {
    FLOW_DATA_DIR: dataDir(),
    FLOW_AUTH_PATH: authJsonPath(),
    FLOW_MODE: mode,
    PORT: String(port),
    NODE_ENV: "production",
  };
  killPort(port);
  const pid = spawnService({
    cwd: dashboardDir(),
    cmd: [nodeBin(dashboardDir(), "next"), "start", "--port", String(port)],
    env: dashEnv,
    logFile: join(dataDir(), "logs", "dashboard.log"),
  });
  writeDashboardPid(pid);
  return pid;
}

// Migration sweep: earlier installs ran one dashboard PER PROJECT on
// ports.dashboard (7600, 7610, …). Kill them so stale processes can't sit on
// old ports serving a dead build; the singleton replaces them all. Also clear
// tracked per-project dashboard pids. Runs on every `flow up` — idempotent,
// a no-op once nothing legacy is left.
function cleanupLegacyDashboards() {
  const singleton = dashboardPort();
  for (const { name, project } of listProjects()) {
    const legacyPort = project?.ports?.dashboard;
    if (legacyPort && legacyPort !== singleton) killPort(legacyPort);
    const pids = readPids(name);
    if (pids.dashboard) {
      if (isAlive(pids.dashboard)) {
        try { process.kill(pids.dashboard, "SIGKILL"); } catch { /* gone */ }
      }
      delete pids.dashboard;
      writePids(name, pids);
    }
  }
}

// Resolve a dependency binary (tsx, next) from wherever npm put it: the
// package's own node_modules, OR the hoisted root node_modules. npm workspaces
// hoist shared deps to the root, so hardcoding `<subdir>/node_modules/.bin/x`
// works on a per-package install but is missing on a clean root install —
// which silently broke service startup on fresh clones ("didn't start").
function nodeBin(subdir, name) {
  const candidates = [
    join(subdir, "node_modules", ".bin", name),
    join(flowRoot, "node_modules", ".bin", name), // flowRoot is a const path, not a fn
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) die(`"${name}" not found — run  npm install  in the flow directory first.`);
  return found;
}

// Probe the orchestrator's native module (better-sqlite3) the same way the
// orchestrator will load it — from orchestratorDir, nearest-node_modules-first.
// Catches the "pulled the fix but node_modules is poisoned" clone: an install
// attempted on another Node leaves a nested copy built for the wrong ABI, which
// SHADOWS the fresh root install and crashes the orchestrator at startup with a
// cryptic NODE_MODULE_VERSION error buried in a log file. Fail up front, with
// the exact fix, instead.
function preflightNativeDeps() {
  const probe = spawnSync(process.execPath, ["-e", "require('better-sqlite3')"], {
    cwd: orchestratorDir(),
    encoding: "utf8",
  });
  if (probe.status === 0) return;
  const err = probe.stderr ?? "";
  if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against/.test(err)) {
    die(
      `A dependency (better-sqlite3) was built for a different Node version — usually a\n` +
        `  leftover from an earlier install attempt on another Node. Fix it with a clean\n` +
        `  reinstall from the flow directory:\n` +
        `      rm -rf node_modules orchestrator/node_modules graph-gateway/node_modules dashboard/node_modules\n` +
        `      npm install\n` +
        `  then re-run  flow up`
    );
  }
  if (/Cannot find module 'better-sqlite3'/.test(err)) {
    die(`Dependencies aren't installed — run  npm install  in the flow directory first.`);
  }
  die(`better-sqlite3 failed to load:\n  ${err.trim().split("\n").slice(0, 3).join("\n  ")}`);
}

function spawnService({ cwd, cmd, env, logFile }) {
  const fd = openSync(logFile, "a");
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  closeSync(fd);
  return child.pid;
}

// ── Box drawing helpers ───────────────────────────────────────────────────────

function padR(str, n) {
  return String(str ?? "").slice(0, n).padEnd(n);
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmt = (row) =>
    "| " + row.map((cell, i) => padR(cell, widths[i])).join(" | ") + " |";

  console.log(sep);
  console.log(fmt(headers));
  console.log(sep);
  for (const row of rows) console.log(fmt(row));
  console.log(sep);
}

// ── COMMAND: project create ───────────────────────────────────────────────────

// Create a project on disk. Pure side-effect + return metadata; prints nothing
// so callers (explicit create, or create-on-`up`) control their own output.
// Names that collide with the dashboard's deployment-level URLs (/login,
// /api/…) or the legacy /p/ prefix — a project can't live at those paths.
const RESERVED_PROJECT_NAMES = new Set(["login", "api", "p", "_next", "favicon.ico", "data", "logs", "mcp", "connect"]);

function createProject(name, { mode = "local", graph, kind } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    die(`Invalid project name "${name}" — use only letters, digits, _ and -`);
  }
  if (RESERVED_PROJECT_NAMES.has(name.toLowerCase())) {
    die(`"${name}" is reserved (it collides with a dashboard URL) — pick another name.`);
  }
  const existingNames = listProjectNames();
  if (existingNames.includes(name)) die(`Project "${name}" already exists at ${projectDir(name)}`);

  const graphName = graph ?? name;
  const ports = portsForIndex(existingNames.length);

  for (const existing of listProjects()) {
    const ep = existing.project.ports;
    if (ep.gateway === ports.gateway || ep.orchestrator === ports.orchestrator || ep.dashboard === ports.dashboard) {
      die(`Port conflict with project "${existing.name}" (${ep.dashboard}). Remove it or pick a different name.`);
    }
  }

  const dir = projectDir(name);
  const workspaceDir = join(dir, "workspace");
  mkdirSync(dir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });

  writeProject(name, { name, graph: graphName, mode, ports, repos: [], ...(kind ? { kind } : {}) });

  const adminToken = randomBytes(24).toString("hex");
  writeFileSync(
    join(dir, ".env"),
    `# Project: ${name}
# Secrets merged into the environment on "flow up ${name}". Never commit this file.
#
# Dashboard login + API bearer (auto-generated — only needed in prod mode):
FLOW_ADMIN_TOKEN=${adminToken}
#
# Add integration keys as you connect them (or set them from the dashboard):
# SLACK_BOT_TOKEN=        # prod-mode only
# SLACK_APP_TOKEN=        # prod-mode only
# LINEAR_API_KEY=
# OPENROUTER_API_KEY=
# LLM_BASE_URL=           # any OpenAI-compatible API (classifier + embeddings)
# LLM_API_KEY=
# GITHUB_TOKEN=
`,
    { encoding: "utf-8", mode: 0o600 }
  );

  const templateOpencode = join(indexWorkspaceDir(), ".opencode");
  if (existsSync(templateOpencode)) {
    cpSync(templateOpencode, join(workspaceDir, ".opencode"), { recursive: true });
  } else {
    mkdirSync(join(workspaceDir, ".opencode"), { recursive: true });
  }
  const templateAgentsMd = join(indexWorkspaceDir(), "AGENTS.md");
  if (existsSync(templateAgentsMd)) {
    writeFileSync(join(workspaceDir, "AGENTS.md"), readFileSync(templateAgentsMd, "utf-8"), "utf-8");
  }
  writeFileSync(join(workspaceDir, "repos.json"), JSON.stringify({ repos: [] }, null, 2) + "\n", "utf-8");

  return { name, dir, ports, adminToken, graph: graphName, mode };
}

async function cmdProjectCreate(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { graph: { type: "string" }, mode: { type: "string", default: "local" } },
  });
  const name = positionals[0];
  if (!name) die("Usage: flow project create <name> [--mode local|prod]");
  const p = createProject(name, { mode: values.mode === "prod" ? "prod" : "local", graph: values.graph });
  console.log(`\n${OK} created ${c.bold(name)}  ${c.dim(`(${p.mode} mode)`)}`);
  console.log(`  ${c.dim("start it with")}  flow up ${name}\n`);
}

// ── COMMAND: up ───────────────────────────────────────────────────────────────

async function cmdUp(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      mode: { type: "string", default: "local" },
      "no-update": { type: "boolean", default: false },
    },
  });
  if (!values["no-update"]) maybeSelfUpdate(); // may re-exec and not return
  const targetName = positionals[0] ?? null;

  // No name → start every project. A name that doesn't exist → offer to create
  // it (guards against typos: you can say no).
  let names;
  if (targetName) {
    if (!existsSync(projectJsonPath(targetName))) {
      const existing = listProjectNames();
      const near = existing.find((n) => n.toLowerCase() === targetName.toLowerCase());
      if (near) die(`No project "${targetName}". Did you mean "${near}"?  (project names are case-sensitive)`);
      if (!process.stdin.isTTY) {
        die(`No project "${targetName}". Create it with:  flow project create ${targetName}`);
      }
      console.log(`\n  No project named ${c.bold(targetName)} yet.`);
      const yes = await confirm(`  Create it?`, true);
      if (!yes) {
        console.log(c.dim(existing.length ? `\n  Existing projects: ${existing.join(", ")}\n` : "\n"));
        return;
      }
      const p = createProject(targetName, { mode: values.mode === "prod" ? "prod" : "local" });
      console.log(`  ${OK} created ${c.bold(targetName)} ${c.dim(`(${p.mode} mode)`)}`);
    }
    names = [targetName];
  } else {
    names = listProjectNames();
    if (names.length === 0) {
      console.log(`\n  No projects yet. Create and start one with:  ${c.bold("flow up <name>")}\n`);
      return;
    }
  }

  console.log(`\n${c.bold("Flow")}`);
  preflightNativeDeps();
  const fk = await ensureFalkordb();
  if (fk === "launched") console.log(c.dim("  FalkorDB launched (first run)"));
  else if (fk === "started") console.log(c.dim("  FalkorDB started"));
  // "running" / "external": already reachable — stay quiet.
  const rebuilt = ensureDashboardBuild(); // shared .next; only prints if it rebuilds
  console.log("");

  const results = [];
  for (const name of names) {
    results.push(await upProject(name, { rebuilt }));
  }

  // Legacy per-project dashboards (pre-single-dashboard installs) die here;
  // then THE dashboard comes up — restarted unconditionally so it can never
  // be left serving a stale shared build (the unstyled-page bug).
  void rebuilt;
  cleanupLegacyDashboards();
  const mode = deploymentMode();
  const { setupToken } = ensureAuthStore(mode);
  const dashUrl = `http://localhost:${dashboardPort()}`;
  spawnDashboard(mode);
  const dashOk = await waitForHealth(`${dashUrl}/login`, 45000);
  if (!dashOk) {
    console.log(`\n  ${FAIL} dashboard didn't start — log: ${relative(process.cwd(), join(dataDir(), "logs", "dashboard.log"))}`);
    process.exitCode = 1;
  }

  // Summary: one dashboard, a URL per project, and how to get in.
  const up = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  if (dashOk && up.length > 0) {
    console.log("");
    for (const r of up) {
      console.log(`  ${c.bold(r.name.padEnd(16))} ${c.cyan(`${dashUrl}/${r.name}`)}`);
    }
    console.log("");
    if (mode !== "prod") {
      console.log(`  ${c.dim("Local mode — open a project and you're already signed in.")}`);
    } else if (setupToken) {
      console.log(`  ${c.dim("First-time setup: open")} ${c.cyan(`${dashUrl}/login`)} ${c.dim("and create the owner account.")}`);
      console.log(`  ${c.dim("Setup code:")} ${c.bold(setupToken)} ${c.dim("(works once — manage accounts in Settings afterwards)")}`);
    } else {
      console.log(`  ${c.dim("Sign in at")} ${c.cyan(`${dashUrl}/login`)} ${c.dim("with your Flow account.")}`);
    }
  }
  if (failed.length > 0) {
    console.log(`\n  ${FAIL} ${failed.map((r) => r.name).join(", ")} didn't come up — check the logs above.`);
    process.exitCode = 1;
  }
  console.log("");
}

async function upProject(name, { rebuilt = false } = {}) {
  const project = readProject(name);
  const dir = projectDir(name);
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });

  const { ports, graph, mode } = project;
  // A "runner" is a gateway-less project: an orchestrator that runs coding
  // agents for connected clouds, binding each cloud's brain over MCP per
  // session (see runtime.ts flowGraphMcp). It has no local gateway, no
  // FalkorDB, no indexer — so skip all of that below and health-check only the
  // orchestrator. This is the "run agents on my machine" runner `flow connect`
  // stands up.
  const isRunner = project.kind === "runner";
  const label = c.bold(name.padEnd(16));

  // Already running? Use port-in-use, not a health probe — a flaky probe used
  // to trick us into starting a SECOND orchestrator on the busy port (which
  // then "didn't start"). If the orchestrator port is held AND it was spawned
  // from the code we'd spawn now, keep it (and any agent sessions). The
  // dashboard is deployment-level now and is restarted unconditionally in
  // cmdUp after the project loop.
  //
  // But if the checkout moved since the services were spawned (self-update
  // pulled, or a branch switch), keeping them would silently run OLD code —
  // services load source at spawn (tsx), so migrations and reconcilers in the
  // new code would never fire. Compare git HEAD against the stamp written at
  // spawn time and fall through to a full restart on mismatch. A missing
  // stamp (pre-stamp install) also restarts, once, to converge. Uncommitted
  // edits don't move HEAD — dev checkouts restart manually, as ever.
  if (portInUse(ports.orchestrator)) {
    const head = codeHead();
    const stampFile = join(dir, "code-head");
    const stamp = existsSync(stampFile) ? readFileSync(stampFile, "utf-8").trim() : null;
    if (!head || head === stamp) {
      void rebuilt; // the deployment dashboard is refreshed unconditionally in cmdUp
      console.log(`  ${label} ${OK} ${c.dim("already running")}`);
      return { name, ok: true, ports, mode, alreadyRunning: true };
    }
    console.log(
      `  ${label} ${c.dim(`code changed (${(stamp ?? "unstamped").slice(0, 7)} → ${head.slice(0, 7)}) — restarting services`)}`,
    );
    killPort(ports.orchestrator);
  }

  // Inline progress line (fills in on completion) when attached to a terminal.
  if (useColor) process.stdout.write(`  ${label} ${c.dim("starting…")}`);
  const finish = (text) => {
    if (useColor) process.stdout.write("\r\x1b[K");
    console.log(`  ${label} ${text}`);
  };

  // Full start: clear any survivors on OUR ports first. A half-dead project
  // (e.g. orchestrator crashed, gateway still up) otherwise makes the fresh
  // spawn die with EADDRINUSE while the STALE process answers the health
  // check — "ready", but serving old code. (The dashboard port is deployment-
  // level and handled in cmdUp — never touch it per project.)
  if (!isRunner) killPort(ports.gateway);

  // Stamp the code these services are spawned from (see the already-running
  // check above). Written before the spawns so a crash mid-start re-runs a
  // full start next time rather than trusting half-started services.
  {
    const head = codeHead();
    if (head) writeFileSync(join(dir, "code-head"), head + "\n");
  }

  // Parse project .env
  const projectEnv = parseEnvFile(join(dir, ".env"));

  // This project is (re)using its graph on purpose — clear any deletion
  // tombstone a previous `flow rm` left, or the gateway will refuse writes.
  // Best-effort: if FalkorDB isn't up yet the services will say so loudly.
  if (!isRunner) {
    try {
      const falkorHost = projectEnv.FALKOR_HOST ?? process.env.FALKOR_HOST ?? "localhost";
      const falkorPort = Number(projectEnv.FALKOR_PORT ?? process.env.FALKOR_PORT ?? 6379);
      await clearGraphTombstone({ graph, host: falkorHost, port: falkorPort });
    } catch {
      /* FalkorDB not reachable yet — nothing to clear */
    }
  }

  // Determine paths for this project
  const dbPath = join(dir, "flow.db");
  const journalPath = join(dir, "journal.jsonl");
  const workspaceDir = join(dir, "workspace");
  const reposJsonPath = join(workspaceDir, "repos.json");

  // Re-sync the indexer workspace template from this checkout. The .opencode
  // tools/agents are copied at project creation, but they must track the code
  // they talk to: when the gateway started requiring bearer auth, every
  // pre-existing workspace kept a tokenless graph tool and reindex jobs 401'd
  // on every write. Convergent and idempotent on each full start, same
  // philosophy as the gateway's boot reconcilers; cpSync overwrites template
  // files and leaves any extra workspace files alone.
  if (!isRunner && existsSync(workspaceDir)) {
    const templateOpencode = join(indexWorkspaceDir(), ".opencode");
    if (existsSync(templateOpencode)) {
      // Plugin-era tool files must be actively removed: cpSync overwrites but
      // never deletes, and a leftover graph.ts/notify.ts re-triggers opencode's
      // per-workspace @opencode-ai/plugin install — whose transitive deps carry
      // Node engines constraints we don't control (the exact failure the MCP
      // config below replaces).
      rmSync(join(workspaceDir, ".opencode", "tools", "graph.ts"), { force: true });
      rmSync(join(workspaceDir, ".opencode", "tools", "notify.ts"), { force: true });
      cpSync(templateOpencode, join(workspaceDir, ".opencode"), { recursive: true });
    }
    const templateAgentsMd = join(indexWorkspaceDir(), "AGENTS.md");
    if (existsSync(templateAgentsMd)) {
      writeFileSync(join(workspaceDir, "AGENTS.md"), readFileSync(templateAgentsMd, "utf-8"), "utf-8");
    }
    // Graph tools reach the workspace as MCP, not as plugin tool files: point
    // opencode at the gateway's MCP server in builder mode. Generated (not
    // copied from the template) because the command needs absolute paths into
    // THIS checkout. Per-job env (graph name, journal, tokens, write scope,
    // actor) is inherited from the spawning opencode process, which gets it
    // from the orchestrator.
    const opencodeConfig = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        graph: {
          type: "local",
          command: [nodeBin(gatewayDir(), "tsx"), join(gatewayDir(), "src", "mcp.ts")],
          environment: { GATEWAY_MCP_MODE: "builder" },
        },
      },
    };
    writeFileSync(join(workspaceDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2) + "\n", "utf-8");
  }

  // ── Gateway (skipped for a brainless runner) ───────────────────────────────
  let gwPid = null;
  if (!isRunner) {
  const gwLogFile = join(logsDir, "gateway.log");
  const gwEnv = {
    ...projectEnv,
    GRAPH_NAME: graph,
    GATEWAY_PORT: String(ports.gateway),
    JOURNAL_PATH: journalPath,
    // PAT auth: the gateway accepts per-user tokens from the deployment auth
    // store, checking the minting user's grant on THIS project.
    FLOW_AUTH_PATH: authJsonPath(),
    FLOW_PROJECT_NAME: name,
    // Lets the gateway's HTTP-served orient reach the memory tiers (orient
    // docs, stats) — MCP spawns inject this per-process, the long-running
    // server needs it in its own env for CLI/remote verb callers.
    ORCHESTRATOR_URL: `http://localhost:${ports.orchestrator}`,
    NODE_ENV: "production",
  };
  // Direct LLM callers (classification) may use an OpenAI-compatible provider.
  // Embeddings are local and need no key; these remain gateway-compatible env
  // for deployments that still override other LLM behavior.
  for (const key of ["LLM_API_KEY", "LLM_BASE_URL", "OPENROUTER_API_KEY"]) {
    if (!gwEnv[key]) {
      const k = readGlobalKey(dir, key) ?? process.env[key];
      if (k) gwEnv[key] = k;
    }
  }

  gwPid = spawnService({
    cwd: gatewayDir(),
    cmd: [nodeBin(gatewayDir(), "tsx"), "src/server.ts"],
    env: gwEnv,
    logFile: gwLogFile,
  });
  }

  // ── Orchestrator ───────────────────────────────────────────────────────────
  const orchLogFile = join(logsDir, "orchestrator.log");
  const orchEnv = {
    ...projectEnv,
    DB_PATH: dbPath,
    ORCHESTRATOR_PORT: String(ports.orchestrator),
    GATEWAY_URL: `http://localhost:${ports.gateway}`,
    OPENCODE_WORKSPACE_DIR: workspaceDir,
    FLOW_MODE: mode,
    REPOS_JSON_PATH: reposJsonPath,
    // Inherited down to gateway MCP subprocesses spawned by indexer jobs.
    // Graph operations still use FalkorDB directly; embeddings borrow this
    // project's long-lived gateway model through GATEWAY_URL.
    GRAPH_NAME: graph,
    JOURNAL_PATH: journalPath,
    NODE_ENV: "production",
  };

  const orchPid = spawnService({
    cwd: orchestratorDir(),
    cmd: [nodeBin(orchestratorDir(), "tsx"), "src/index.ts"],
    env: orchEnv,
    logFile: orchLogFile,
  });

  writePids(name, { gateway: gwPid, orchestrator: orchPid });

  // ── Wait for health (the deployment dashboard is handled in cmdUp) ─────────
  const [gwOk, orchOk] = await Promise.all([
    isRunner ? Promise.resolve(true) : waitForHealth(`http://localhost:${ports.gateway}/health`, 25000),
    waitForHealth(`http://localhost:${ports.orchestrator}/health`, 25000),
  ]);

  if (gwOk && orchOk) {
    finish(`${OK} ${c.dim("services up")}`);
    return { name, ok: true, ports, mode };
  }

  const failed = [!gwOk && "gateway", !orchOk && "orchestrator"].filter(Boolean);
  finish(`${FAIL} ${c.red(failed.join(", ") + " didn't start")}`);
  for (const svc of failed) {
    console.log(`      ${c.dim("log:")} ${relative(process.cwd(), join(logsDir, `${svc}.log`))}`);
  }
  return { name, ok: false, ports, mode };
}

// ── COMMAND: down ─────────────────────────────────────────────────────────────

async function cmdDown(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const targetName = positionals[0] ?? null;

  const names = targetName ? [targetName] : listProjectNames();
  if (names.length === 0) {
    console.log(c.dim("\n  No projects.\n"));
    return;
  }

  console.log(`\n${c.bold("Flow")} ${c.dim("· stopping")}`);
  for (const name of names) {
    await downProject(name);
  }
  // Whole-deployment down also stops THE dashboard. A single-project down
  // leaves it running — it serves the other projects.
  if (!targetName) {
    stopDashboard();
    stopOwnedFalkordb();
  }
  console.log("");
}

// TESTING-ONLY: stop this deployment's private FalkorDB container on a
// whole-deployment down. Applies ONLY when FALKOR_CONTAINER is set — which
// only a `setup.sh --fresh-db` launcher bakes in — marking this deployment as
// the container's sole owner. The default shared flow-falkordb container is
// substrate for every deployment on the machine and is NEVER touched here,
// even if someone points FALKOR_CONTAINER at it. `docker stop`, not `rm`:
// graph data survives, and the next `flow up` restarts the container.
function stopOwnedFalkordb() {
  const container = process.env.FALKOR_CONTAINER;
  if (!container || container === "flow-falkordb") return;
  const res = spawnSync("docker", ["stop", container], { encoding: "utf8" });
  const stopped = res.status === 0;
  console.log(
    `  ${c.bold("falkordb".padEnd(16))} ${stopped ? `${OK} ${c.dim(`stopped (${container})`)}` : c.dim("· not running")}`
  );
}

function stopDashboard() {
  let touched = false;
  try {
    const pid = JSON.parse(readFileSync(join(dataDir(), "dashboard.json"), "utf-8"))?.pid;
    if (pid && isAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); touched = true; } catch { /* gone */ }
    }
  } catch { /* no tracked pid */ }
  if (portInUse(dashboardPort())) {
    killPort(dashboardPort());
    touched = true;
  }
  console.log(`  ${c.bold("dashboard".padEnd(16))} ${touched ? `${OK} ${c.dim("stopped")}` : c.dim("· not running")}`);
}

async function downProject(name) {
  const pids = readPids(name);
  const services = ["gateway", "orchestrator", "dashboard"];
  let touched = false;

  // SIGTERM tracked pids, then SIGKILL survivors after a grace period.
  const alive = services.map((svc) => pids[svc]).filter((pid) => pid && isAlive(pid));
  for (const pid of alive) {
    try {
      process.kill(pid, "SIGTERM");
      touched = true;
    } catch {
      /* already gone */
    }
  }
  if (alive.length) {
    await new Promise((r) => setTimeout(r, 3000));
    for (const pid of alive) {
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  }

  // Port-based fallback: pids.json can go stale (manual restarts, crashes),
  // leaving a service alive so the next `up` reuses old code. Kill whatever
  // still holds each project port. The deployment dashboard's port is NOT a
  // project port — skip it (legacy per-project dashboard ports still swept).
  const project = readProject(name);
  if (project?.ports) {
    const projectPorts = Object.entries(project.ports)
      .filter(([svc, port]) => !(svc === "dashboard" && port === dashboardPort()))
      .map(([, port]) => port);
    for (const port of projectPorts) {
      try {
        const out = (spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "").trim();
        for (const p of out.split("\n").filter(Boolean)) {
          try {
            process.kill(Number(p), "SIGKILL");
            touched = true;
          } catch {
            /* gone */
          }
        }
      } catch {
        /* lsof unavailable */
      }
    }
  }

  writePids(name, {});
  console.log(`  ${c.bold(name.padEnd(16))} ${touched ? `${OK} ${c.dim("stopped")}` : c.dim("· not running")}`);
}

// ── COMMAND: ls ───────────────────────────────────────────────────────────────

async function cmdLs() {
  const projects = listProjects();
  if (projects.length === 0) {
    console.log("\nNo projects found. Run: flow project create <name>\n");
    return;
  }

  const rows = await Promise.all(
    projects.map(async ({ name, project }) => {
      const pids = readPids(name);
      const { ports, mode, graph } = project;

      // Check orchestrator health
      const orchUrl = `http://localhost:${ports.orchestrator}/health`;
      const orchOk = await probe(orchUrl, 1500);

      // Determine status
      let status;
      if (orchOk) {
        status = "RUNNING";
      } else if (pids.orchestrator && isAlive(pids.orchestrator)) {
        status = "STARTING";
      } else {
        status = "STOPPED";
      }

      void ports;
      const dashUrl = `http://localhost:${dashboardPort()}/${name}`;
      return [
        name,
        mode,
        status,
        status === "STOPPED" ? "-" : dashUrl,
        graph,
      ];
    })
  );

  console.log();
  printTable(["PROJECT", "MODE", "STATUS", "DASHBOARD URL", "GRAPH"], rows);
  console.log();
}

// ── COMMAND: doctor ───────────────────────────────────────────────────────────
// Health-check every project: services up, every page reachable, and — the one
// that bites — the dashboard's CSS/JS assets actually load (a stale shared build
// leaves a running dashboard serving dead chunk hashes → unstyled page).

const DOCTOR_PAGES = ["/", "/ask", "/agents", "/connections", "/permissions", "/activity", "/settings"];

async function fetchStatus(url, opts = {}) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4000), ...opts });
    return { status: res.status, text: opts.body === undefined && opts.wantText ? await res.text() : null };
  } catch {
    return { status: 0, text: null };
  }
}

async function cmdDoctor() {
  const projects = listProjects();
  if (projects.length === 0) {
    console.log(c.dim("\n  No projects.\n"));
    return;
  }
  console.log(`\n${c.bold("Flow")} ${c.dim("· doctor")}\n`);
  let anyFail = false;
  const base = `http://localhost:${dashboardPort()}`;

  // THE dashboard, once: up + serving live assets. /login is the one page
  // that renders 200 without auth in both modes, so the asset check uses it.
  {
    const problems = [];
    const login = await fetchStatus(`${base}/login`, { wantText: true });
    if (login.status === 0) {
      problems.push("dashboard down");
    } else if (login.status >= 500) {
      problems.push(`login ${login.status}`);
    } else if (login.text) {
      const assets = [...login.text.matchAll(/\/_next\/static\/[^"']+\.(?:css|js)/g)].map((m) => m[0]).slice(0, 4);
      if (assets.length === 0) {
        problems.push("no CSS/JS referenced");
      } else {
        for (const a of assets) {
          const r = await fetchStatus(`${base}${a}`);
          if (r.status !== 200) {
            problems.push(`asset ${r.status || "unreachable"} (stale build?)`);
            break;
          }
        }
      }
    }
    const label = c.bold("dashboard".padEnd(16));
    if (problems.length === 0) {
      console.log(`  ${label} ${OK} ${c.dim("up + assets OK")}   ${c.cyan(base)}`);
    } else {
      anyFail = true;
      console.log(`  ${label} ${FAIL} ${c.red(problems.slice(0, 5).join(", "))}`);
    }
  }

  for (const { name, project } of projects) {
    const { ports } = project;
    const problems = [];

    if (!(await probe(`http://localhost:${ports.gateway}/health`, 2500))) problems.push("gateway down");
    if (!(await probe(`http://localhost:${ports.orchestrator}/health`, 2500))) problems.push("orchestrator down");

    // Every page reachable under this project's prefix (flag only crashes/
    // unreachable — a 3xx auth redirect in prod is fine, not a failure).
    for (const path of DOCTOR_PAGES) {
      const r = await fetchStatus(`${base}/${name}${path === "/" ? "/" : path}`);
      if (r.status === 0 || r.status >= 500) problems.push(`${path} ${r.status || "unreachable"}`);
    }

    const label = c.bold(name.padEnd(16));
    if (problems.length === 0) {
      console.log(`  ${label} ${OK} ${c.dim("services + pages OK")}   ${c.cyan(`${base}/${name}`)}`);
    } else {
      anyFail = true;
      console.log(`  ${label} ${FAIL} ${c.red(problems.slice(0, 5).join(", "))}`);
    }
  }
  console.log("");
  if (anyFail) {
    console.log(c.dim("  If assets are stale, run  flow up  — it restarts the dashboard on the fresh build.\n"));
    process.exitCode = 1;
  }
}

// ── COMMAND: rm ───────────────────────────────────────────────────────────────

async function cmdRm(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const name = positionals[0];
  if (!name) die("Usage: flow rm <name>");
  if (!existsSync(projectJsonPath(name))) die(`No project "${name}".`);
  if (process.stdin.isTTY) {
    const yes = await confirm(`  Delete ${c.bold(name)} and all its data (graph, db, cloned repos)?`, false);
    if (!yes) {
      console.log(c.dim("  cancelled\n"));
      return;
    }
  }
  console.log(`\n${c.bold("Flow")} ${c.dim("· removing " + name)}`);
  const project = readProject(name);
  const projectEnv = parseEnvFile(join(projectDir(name), ".env"));
  await downProject(name);

  // FalkorDB is shared across projects, but each project normally owns one
  // named graph. Delete that graph before removing project.json so a failed DB
  // connection leaves enough metadata for the user to retry instead of
  // creating a permanently orphaned graph. A custom graph may intentionally
  // be shared; preserve it while another registered project still uses it.
  const sharedWith = listProjects().find(
    ({ name: otherName, project: other }) => otherName !== name && other.graph === project.graph,
  );
  if (sharedWith) {
    console.log(`  ${c.dim(`· graph ${project.graph} kept (shared with ${sharedWith.name})`)}`);
  } else {
    const host = projectEnv.FALKOR_HOST ?? process.env.FALKOR_HOST ?? "localhost";
    const port = Number(projectEnv.FALKOR_PORT ?? process.env.FALKOR_PORT ?? 6379);
    let result;
    try {
      result = await deleteProjectGraph({ graph: project.graph, host, port });
    } catch (err) {
      throw new Error(
        `Couldn't delete FalkorDB graph "${project.graph}" at ${host}:${port}; project files were kept so you can retry.\n` +
          `  ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.log(`  ${result.existed ? OK : c.dim("·")} ${c.dim(result.existed ? `deleted graph ${project.graph}` : `graph ${project.graph} already empty`)}`);
  }

  rmSync(projectDir(name), { recursive: true, force: true });
  console.log(`  ${OK} removed ${c.bold(name)}\n`);
}

// ── Remotes: connect this machine to other Flow deployments ──────────────────
//
// A "remote" is another Flow deployment (a team's EC2, a second box) this
// machine holds a credential for. `flow connect <url>` runs a device flow:
// the dashboard mints a personal access token for the approving user, and it
// lands in ~/.flow/config.json — machine-level, shared by every alias, never
// inside a project's data dir. The PAT inherits the user's project grants;
// revoking it in the dashboard cuts this machine off within seconds.

function userConfigPath() {
  return join(homedir(), ".flow", "config.json");
}

function readUserConfig() {
  try {
    return JSON.parse(readFileSync(userConfigPath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeUserConfig(cfg) {
  mkdirSync(join(homedir(), ".flow"), { recursive: true });
  writeFileSync(userConfigPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

function openInBrowser(target) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [target], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Printing the URL is the fallback; never fail the flow over a browser.
  }
}

async function cmdConnect(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { name: { type: "string" }, code: { type: "string" } },
    allowPositionals: true,
  });
  let url = positionals[0];
  if (!url) die(`Usage: flow connect <dashboard-url> [--name <remote-name>]`);
  if (!/^https?:\/\//.test(url)) {
    url = (/^(localhost|127\.)/.test(url) ? "http://" : "https://") + url;
  }
  url = url.replace(/\/+$/, "");

  // Sanity check: is this a Flow deployment, and does it need connecting?
  let status;
  try {
    const res = await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(8000) });
    status = await res.json();
  } catch (err) {
    die(`Couldn't reach ${url} — is that the dashboard URL? (${err instanceof Error ? err.message : err})`);
  }
  if (status.mode !== "prod") {
    die(`${url} runs in local mode — the dashboard and CLI already share the machine, nothing to connect.`);
  }

  // Stable identity: key the remote by deploymentId, not URL, so a later
  // address change (new EC2 IP, renamed DNS) reconnects the SAME remote in
  // place instead of forking a duplicate. Older deployments predate the
  // endpoint (null id) — those fall back to URL-based naming.
  let deploymentId = null;
  try {
    const dep = await fetch(`${url}/api/deployment`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    deploymentId = dep?.deploymentId ?? null;
  } catch {
    // Non-fatal — proceed with URL-based identity.
  }

  const label = hostname();
  // Pairing secret: lets pages served by THIS deployment (in a browser on
  // THIS machine) call the local dashboard cross-origin — see the execution
  // door in dashboard/src/proxy.ts. Generated here, shared with the
  // deployment via the device flow, kept locally in the remote entry.
  const pairing = randomBytes(24).toString("hex");
  // Where a browser on this machine can reach THIS Flow's dashboard — the
  // deployment hands it back to the user's pages so the execution client
  // probes the right port (offsets exist: test aliases, multiple installs).
  const localUrl = `http://localhost:${dashboardPort()}`;

  // ── One-command install path: --code carries a pre-blessed code the
  // dashboard already minted for the logged-in user. Skip the browser
  // approval round-trip; just complete it with this machine's pairing.
  let token;
  if (values.code) {
    const res = await fetch(`${url}/api/auth/device/${values.code}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, pairing, local_url: localUrl }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) {
      die(body.error ?? `Connect failed (${res.status}) — the install code may have expired; get a fresh command from the dashboard.`);
    }
    token = body.token;
  }

  // No pre-blessed code (or it didn't yield a token) → interactive browser
  // approval. Skipped entirely on the one-command `--code` path above.
  if (!token) {
  const startRes = await fetch(`${url}/api/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, pairing, local_url: localUrl }),
  });
  const start = await startRes.json();
  if (!startRes.ok) die(start.error ?? `Connect failed (${startRes.status})`);

  const approveUrl = `${url}/connect?code=${start.code}`;
  console.log(`\n  Approve this machine (${c.bold(label)}) in your browser:`);
  console.log(`  ${c.cyan(approveUrl)}\n`);
  openInBrowser(approveUrl);

  process.stdout.write(`  ${c.dim("Waiting for approval…")} `);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${url}/api/auth/device/${start.code}/claim`, { method: "POST" }).catch(() => null);
    if (!res) continue; // transient network blip — keep polling
    if (res.status === 404) {
      console.log("");
      die("Connect code expired — run `flow connect` again.");
    }
    const body = await res.json().catch(() => ({}));
    if (body.status === "approved" && body.token) {
      token = body.token;
      break;
    }
  }
  console.log("");
  if (!token) die("Timed out waiting for approval (10 minutes) — run `flow connect` again.");
  }

  saveRemote(url, deploymentId, token, pairing, localUrl, values.name);
  // Stand up this machine's execution runner so the user can immediately run
  // agents here against the cloud's brain — the second half of the one command.
  await ensureRunnerUp();
}

// Write (or reconnect-in-place) a remote to ~/.flow/config.json, keyed by
// deploymentId so an address change updates rather than forks. Shared by the
// classic browser-approval path and the one-command --code path.
function saveRemote(url, deploymentId, token, pairing, localUrl, preferredName) {
  const cfg = readUserConfig();
  cfg.remotes ??= {};

  let name = preferredName;
  let addressChanged = false;
  if (deploymentId) {
    for (const [n, r] of Object.entries(cfg.remotes)) {
      if (r?.deploymentId === deploymentId) {
        name ??= n;
        addressChanged = r.url !== url;
        break;
      }
    }
  }
  name ??= new URL(url).host.replace(/[^a-zA-Z0-9._-]/g, "-");

  cfg.remotes[name] = {
    kind: "remote",
    deploymentId,
    url,
    token,
    pairing,
    localUrl,
    connectedAt: new Date().toISOString(),
  };
  writeUserConfig(cfg);

  const verb = addressChanged ? "Reconnected" : "Connected";
  console.log(`  ${OK} ${verb} ${c.bold(name)} → ${url}`);
  if (addressChanged) console.log(`    ${c.dim("(same deployment — address updated in place)")}`);
  console.log(`    ${c.dim("Saved to ~/.flow/config.json — list with")} flow remotes`);
  console.log(`    ${c.dim("MCP endpoint for agents:")} ${url}/<project>/mcp ${c.dim("(bearer = this machine's token)")}\n`);
}

// Stand up (and boot) THIS machine's execution runner: a gateway-less local
// project — an orchestrator with no brain of its own — that runs coding agents
// for any cloud you've connected. Each session binds the cloud project's brain
// over MCP (RemoteBrainComposer → runtime.ts flowGraphMcp), so ONE runner
// serves every deployment. `flow connect` calls this so a brand-new user is
// ready to run agents here without a second command. Idempotent: reuses the
// runner if it exists; a plain `flow up` also boots it like any other project.
async function ensureRunnerUp() {
  let name = "runner";
  if (existsSync(projectJsonPath(name)) && readProject(name).kind !== "runner") {
    name = "flow-runner"; // a real project already owns "runner" — leave it be
  }
  if (!existsSync(projectJsonPath(name))) {
    createProject(name, { mode: "local", kind: "runner" });
  }
  console.log(`\n  ${c.dim("Setting up this machine to run agents (brain stays on the cloud)…")}`);
  preflightNativeDeps();
  const rebuilt = ensureDashboardBuild();
  const res = await upProject(name, { rebuilt });
  spawnDashboard(deploymentMode());
  const dashOk = await waitForHealth(`http://localhost:${dashboardPort()}/login`, 45000);
  if (res.ok && dashOk) {
    console.log(`  ${OK} ${c.bold("Ready.")} Refresh the dashboard tab, then pick a folder and run an agent here.\n`);
  } else {
    console.log(`  ${c.yellow("!")} Runner didn't fully start — run ${c.bold("flow up")} and check the logs.\n`);
  }
}

async function cmdRemotes(args) {
  const sub = args[0];
  const cfg = readUserConfig();
  const remotes = cfg.remotes ?? {};

  if (!sub || sub === "ls" || sub === "list") {
    // Only actual remote deployments — the config also holds a `kind:"local"`
    // entry (the local flow root), which is not a remote and rendered as a junk
    // "undefined … since ?" row before this filter.
    const names = Object.keys(remotes).filter((n) => {
      const r = remotes[n];
      return r && r.kind !== "local" && r.url;
    });
    if (names.length === 0) {
      console.log(`\n  No remotes. Connect one with: ${c.bold("flow connect <dashboard-url>")}\n`);
      return;
    }
    console.log("");
    for (const n of names) {
      const r = remotes[n];
      const id = (r.token?.match(/^flowpat_([0-9a-f]{8})_/) ?? [])[1] ?? "????????";
      console.log(
        `  ${c.bold(n.padEnd(20))} ${r.url}  ${c.dim(`token flowpat_${id}_…  since ${r.connectedAt?.slice(0, 10) ?? "?"}`)}`
      );
    }
    console.log("");
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const name = args[1];
    if (!name || !remotes[name]) {
      die(`No remote "${name ?? ""}". Have: ${Object.keys(remotes).join(", ") || "(none)"}`);
    }
    const r = remotes[name];
    // Best-effort server-side revoke (a PAT may revoke itself); the local
    // entry goes away regardless, and the dashboard Connect page can clean
    // up a leftover token.
    const id = (r.token?.match(/^flowpat_([0-9a-f]{8})_/) ?? [])[1];
    if (id) {
      try {
        const res = await fetch(`${r.url}/api/tokens/${id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${r.token}` },
          signal: AbortSignal.timeout(8000),
        });
        console.log(
          `  ${res.ok ? OK : c.yellow("!")} ${res.ok ? "revoked server-side" : "server-side revoke failed — revoke on the dashboard's /connect page"}`
        );
      } catch {
        console.log(`  ${c.yellow("!")} couldn't reach ${r.url} — revoke on the dashboard's /connect page`);
      }
    }
    delete remotes[name];
    cfg.remotes = remotes;
    writeUserConfig(cfg);
    console.log(`  ${OK} removed remote ${c.bold(name)}\n`);
    return;
  }

  die(`Usage: flow remotes [remove <name>]`);
}

// ── flow setup — bind the current repo to a project + materialize atoms ──────
//
// Folder → (deployment, project) binding, resolved ONCE here and baked into
// the rendered artifacts (`--project X` in every hook line). Nothing is
// resolved at capture time — that's the anti-cross-project-bleed design.

function normalizeGitUrl(u) {
  return String(u)
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// Which registered source (BRAIN repo) does this checkout correspond to?
// localPath match beats remote-URL match beats name match; no match is fine —
// capture still works, the repo is just not an indexed source (BRAIN/WORK split).
function resolveRepoName(projectName, repoDir) {
  let repos = [];
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir(projectName), "workspace", "repos.json"), "utf-8"));
    repos = parsed.repos ?? [];
  } catch {
    /* no registry — fall through */
  }
  const byPath = repos.find((r) => r.localPath === repoDir);
  if (byPath) return { name: byPath.name, registered: true };
  let origin = "";
  try {
    origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: repoDir, encoding: "utf-8" }).stdout ?? "";
  } catch {}
  if (origin.trim()) {
    const norm = normalizeGitUrl(origin);
    const byUrl = repos.find((r) => r.url && normalizeGitUrl(r.url) === norm);
    if (byUrl) return { name: byUrl.name, registered: true };
  }
  const byName = repos.find((r) => r.name === basename(repoDir));
  if (byName) return { name: byName.name, registered: true };
  return { name: basename(repoDir), registered: false };
}

async function cmdSetup(rest) {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      share: { type: "boolean" },
      remove: { type: "boolean" },
      harness: { type: "string" },
      all: { type: "boolean" },
      remote: { type: "string" }, // bind to a project on a connected deployment (flow connect)
    },
    allowPositionals: true,
  });

  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf-8" });
  if (top.status !== 0) die("flow setup must run inside a git repository.");
  const repoDir = top.stdout.trim();

  if (values.remove) {
    removeRepo(repoDir);
    console.log(`\n  ${OK} removed Flow integration artifacts from ${c.bold(repoDir)}\n`);
    return;
  }

  const name = positionals[0];
  if (!name) {
    const names = listProjectNames();
    die(
      `Usage: flow setup <project> [--share] [--harness a,b] [--remove]\n` +
        (names.length ? `  Projects here: ${names.join(", ")}` : `  No projects yet — run: flow up <name>`)
    );
  }
  let projectEntry;
  let repoName;
  let registered = false;
  let workFolderUrl; // where to register the WORK folder (best-effort)
  let workFolderToken;
  const remoteName = values.remote ?? "local";

  if (values.remote) {
    // ── Remote binding: this repo's sessions read/write a project on a
    // deployed Flow (EC2). Everything routes through that deployment's public
    // per-project dashboard routes with the machine's PAT; MCP uses the remote
    // /<project>/mcp endpoint (bridged to stdio by flow-mcp). No local project,
    // no FalkorDB access, no gateway source on this box.
    const cfg = readUserConfig();
    const remoteEntry = cfg.remotes?.[values.remote];
    if (!remoteEntry?.url) {
      const have = Object.keys(cfg.remotes ?? {}).join(", ") || "(none — run: flow connect <url>)";
      die(`No connected deployment "${values.remote}". Connected: ${have}`);
    }
    const base = remoteEntry.url.replace(/\/+$/, "");
    const tok = remoteEntry.token ?? "";

    // Validate the project exists there (and grab its graph) via the public
    // project list — a wrong name fails here with a clear message instead of
    // silently materializing a dead binding.
    let graph = name;
    try {
      const list = await fetch(`${base}/api/projects`, {
        headers: tok ? { authorization: `Bearer ${tok}` } : {},
        signal: AbortSignal.timeout(10000),
      }).then((r) => (r.ok ? r.json() : null));
      const proj = list?.projects?.find((p) => p.name === name);
      if (list && !proj) {
        const names = (list.projects ?? []).map((p) => p.name).join(", ") || "(none you can access)";
        die(`Deployment "${values.remote}" has no project "${name}" you can access. Available: ${names}`);
      }
      if (proj?.graph) graph = proj.graph;
    } catch (err) {
      die(`Couldn't reach deployment "${values.remote}" (${base}): ${err instanceof Error ? err.message : err}`);
    }

    // Remote deployments own their own source registry; we can't read it here,
    // so use the git-derived name and don't claim it's a registered source.
    repoName = resolveRepoName(name, repoDir).name;
    registered = false;
    workFolderUrl = `${base}/${name}/v1/work-folders`;
    workFolderToken = tok;
    projectEntry = {
      remote: values.remote,
      deploymentId: remoteEntry.deploymentId ?? null,
      orchestratorUrl: `${base}/${name}`,
      gatewayUrl: `${base}/${name}`,
      mcpUrl: `${base}/${name}/mcp`,
      graphName: graph,
      token: tok,
    };
  } else {
    const project = readProject(name); // throws with a helpful message if unknown
    const index = listProjectNames().indexOf(name);
    const ports = portsForIndex(index);
    const env = parseEnvFile(join(projectDir(name), ".env"));
    const token = env.FLOW_ADMIN_TOKEN ?? "dev-token";
    const graph = project.graph ?? name;
    const resolved = resolveRepoName(name, repoDir);
    repoName = resolved.name;
    registered = resolved.registered;
    workFolderUrl = `http://localhost:${ports.orchestrator}/v1/work-folders`;
    workFolderToken = token;
    projectEntry = {
      remote: "local",
      orchestratorUrl: `http://localhost:${ports.orchestrator}`,
      gatewayUrl: `http://localhost:${ports.gateway}`,
      graphName: graph,
      token,
      falkorHost: env.FALKOR_HOST ?? process.env.FALKOR_HOST ?? "localhost",
      falkorPort: Number(env.FALKOR_PORT ?? process.env.FALKOR_PORT ?? 6379),
      tsxBin: nodeBin(gatewayDir(), "tsx"),
      gatewayMcp: join(gatewayDir(), "src", "mcp.ts"),
    };
  }

  materializeMachine({
    flowRoot,
    projectName: name,
    shimSource: join(flowRoot, "bin", "harness", "flow-hook.mjs"),
    projectEntry,
  });

  // Default: only the tools this machine actually has. `--all` pre-wires
  // everything; `--harness a,b` picks explicitly.
  const detected = detectHarnesses();
  const harnesses = values.harness
    ? values.harness.split(",").map((s) => s.trim()).filter((h) => ALL_HARNESSES.includes(h))
    : values.all
      ? ALL_HARNESSES
      : detected.length
        ? detected
        : ALL_HARNESSES;
  const skipped = ALL_HARNESSES.filter((h) => !harnesses.includes(h));
  const { owned, merged } = materializeRepo({
    repoDir,
    project: name,
    repo: repoName,
    remote: remoteName,
    share: values.share === true,
    harnesses,
  });

  // WORK-surface registration (work_folders): best-effort — the binding above
  // is complete without it; this makes the folder appear in the dashboard.
  // Local → the local orchestrator; remote → the deployment's public route.
  let workFolderOk = false;
  try {
    const res = await fetch(workFolderUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${workFolderToken}` },
      body: JSON.stringify({ path: repoDir, repo: registered ? repoName : undefined }),
      signal: AbortSignal.timeout(3000),
    });
    workFolderOk = res.ok;
  } catch {
    /* deployment unreachable — fine, registers on next flow up / reconnect */
  }

  const where = values.remote ? `${c.bold(remoteName)} (remote)` : "local";
  console.log(`
  ${OK} ${c.bold(repoDir)}
    → project ${c.bold(name)} on ${where}, repo ${c.bold(repoName)}${registered ? "" : c.yellow(" (not a registered source — capture works; graph context limited)")}
    tools: ${harnesses.join(", ")}${skipped.length ? c.dim(`  (not detected, skipped: ${skipped.join(", ")} — use --all to pre-wire)`) : ""}
    mode:  ${values.share ? "shared (files visible to git — commit them)" : "personal (hidden via .git/info/exclude; use --share for the team)"}
    files: ${[...owned, ...merged].join(", ")}
    work folder: ${workFolderOk ? "registered" : c.yellow("not registered (orchestrator not running — will register on next flow up)")}

  ${c.bold("One-time approvals some tools will ask for:")}
    Claude Code  → first prompt asks to use this repo's .mcp.json — approve.
    Codex        → run ${c.cyan("/hooks")} once in codex here and trust the flow hooks.
    Cursor       → Settings → MCP: approve "flow-graph" when prompted.
    Gemini CLI   → shows "hooks will be executed" notice on first run.
`);
}

// ── Main dispatch ─────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  try {
    if (cmd === "up") {
      await cmdUp(rest);
    } else if (cmd === "down" || cmd === "stop") {
      await cmdDown(rest);
    } else if (cmd === "ls" || cmd === "list" || cmd === "ps") {
      await cmdLs();
    } else if (cmd === "doctor" || cmd === "check" || cmd === "health") {
      await cmdDoctor();
    } else if (cmd === "rm" || cmd === "remove" || cmd === "delete") {
      await cmdRm(rest);
    } else if (cmd === "connect") {
      await cmdConnect(rest);
    } else if (cmd === "remotes" || cmd === "remote") {
      await cmdRemotes(rest);
    } else if (cmd === "setup" || cmd === "connect-repo") {
      await cmdSetup(rest);
    } else if (cmd === "create" || cmd === "new" || cmd === "project") {
      // Tolerate `flow create project X`, `flow new X`, `flow project create X`.
      let a = rest;
      if (a[0] === "project" || a[0] === "create") a = a.slice(1);
      if (a.length === 0) die(`Usage: flow up <name>   ${c.dim("(creates and starts it)")}`);
      await cmdProjectCreate(a);
    } else {
      die(`Unknown command "${cmd}". Try: flow up <name>   (or: flow --help)`);
    }
  } catch (err) {
    die(err.message);
  }
}

main();

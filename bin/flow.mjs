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
import { randomBytes } from "node:crypto";
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
import { join, relative } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { portsForIndex } from "./lib/ports.mjs";
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
import { ensureFalkordb } from "./lib/docker.mjs";

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
  console.log(c.dim("  building dashboard (first run ~30s)…"));
  const res = spawnSync(join(dir, "node_modules/.bin/next"), ["build"], {
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
  try {
    const out = (spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "").trim();
    return out.length > 0;
  } catch {
    return false;
  }
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

// (Re)start just the dashboard for a project against the current shared build.
// Kills any stale process on the port first so a rebuild can't leave a
// dashboard serving dead chunk hashes (the "unstyled page" bug).
function spawnDashboardFor(name) {
  const project = readProject(name);
  const dir = projectDir(name);
  const { ports, mode } = project;
  const projectEnv = parseEnvFile(join(dir, ".env"));
  const dashEnv = {
    ...projectEnv,
    ORCHESTRATOR_URL: `http://localhost:${ports.orchestrator}`,
    GATEWAY_URL: `http://localhost:${ports.gateway}`,
    FLOW_ADMIN_TOKEN: projectEnv.FLOW_ADMIN_TOKEN ?? "flow-dev-token",
    FLOW_MODE: mode,
    REPOS_JSON_PATH: join(dir, "workspace", "repos.json"),
    PORT: String(ports.dashboard),
    NODE_ENV: "production",
  };
  killPort(ports.dashboard);
  const pid = spawnService({
    cwd: dashboardDir(),
    cmd: [join(dashboardDir(), "node_modules/.bin/next"), "start", "--port", String(ports.dashboard)],
    env: dashEnv,
    logFile: join(dir, "logs", "dashboard.log"),
  });
  writePids(name, { ...readPids(name), dashboard: pid });
  return pid;
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
function createProject(name, { mode = "local", graph } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    die(`Invalid project name "${name}" — use only letters, digits, _ and -`);
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

  writeProject(name, { name, graph: graphName, mode, ports, repos: [] });

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
    options: { mode: { type: "string", default: "local" } },
  });
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
  const fk = await ensureFalkordb();
  if (fk !== "running") console.log(c.dim(`  FalkorDB ${fk === "launched" ? "launched (first run)" : "started"}`));
  const rebuilt = ensureDashboardBuild(); // shared .next; only prints if it rebuilds
  console.log("");

  const results = [];
  for (const name of names) {
    results.push(await upProject(name, { rebuilt }));
  }

  // The rebuild replaced chunk hashes on disk, so any dashboard we DIDN'T just
  // start is now serving dead assets (the unstyled-page bug). Refresh them.
  if (rebuilt) {
    const starting = new Set(names);
    for (const other of listProjectNames()) {
      if (starting.has(other)) continue;
      const p = readProject(other)?.ports?.dashboard;
      if (p && (await probe(`http://localhost:${p}/login`, 1000))) {
        spawnDashboardFor(other);
        await waitForHealth(`http://localhost:${p}/login`, 30000);
        console.log(c.dim(`  refreshed ${other} dashboard (new build)`));
      }
    }
  }

  // Summary: dashboards you can open, and how to get in.
  const up = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  if (up.length > 0) {
    const anyLocal = up.some((r) => r.mode !== "prod");
    const anyProd = up.some((r) => r.mode === "prod");
    console.log("");
    if (anyLocal && !anyProd) {
      console.log(`  ${c.dim("Local mode — open a dashboard and you're already signed in.")}`);
    } else if (anyProd) {
      console.log(`  ${c.dim("Prod projects need the admin token from")} data/projects/<name>/.env`);
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
  const dashUrl = `http://localhost:${ports.dashboard}`;
  const label = c.bold(name.padEnd(16));

  // Already running? Use port-in-use, not a health probe — a flaky probe used
  // to trick us into starting a SECOND orchestrator on the busy port (which
  // then "didn't start"). If the orchestrator port is held, keep it (and any
  // agent sessions) and just refresh the dashboard. The dashboard is stateless,
  // and this is the thing that breaks invisibly: dead, or serving a stale
  // shared build after a rebuild (the unstyled-page bug). Cheap insurance.
  if (portInUse(ports.orchestrator)) {
    void rebuilt; // dashboard is refreshed unconditionally below
    spawnDashboardFor(name);
    const dashOk = await waitForHealth(`${dashUrl}/login`, 30000);
    console.log(`  ${label} ${dashOk ? OK : FAIL} ${c.dim(dashOk ? "ready" : "orchestrator up · dashboard failed")}   ${c.cyan(dashUrl)}`);
    return { name, ok: dashOk, ports, mode, alreadyRunning: true };
  }

  // Inline progress line (fills in on completion) when attached to a terminal.
  if (useColor) process.stdout.write(`  ${label} ${c.dim("starting…")}`);
  const finish = (text) => {
    if (useColor) process.stdout.write("\r\x1b[K");
    console.log(`  ${label} ${text}`);
  };

  // Parse project .env
  const projectEnv = parseEnvFile(join(dir, ".env"));

  // Determine paths for this project
  const dbPath = join(dir, "flow.db");
  const journalPath = join(dir, "journal.jsonl");
  const workspaceDir = join(dir, "workspace");
  const reposJsonPath = join(workspaceDir, "repos.json");

  // ── Gateway ────────────────────────────────────────────────────────────────
  const gwLogFile = join(logsDir, "gateway.log");
  const gwEnv = {
    ...projectEnv,
    GRAPH_NAME: graph,
    GATEWAY_PORT: String(ports.gateway),
    JOURNAL_PATH: journalPath,
    NODE_ENV: "production",
  };

  const gwPid = spawnService({
    cwd: gatewayDir(),
    cmd: [join(gatewayDir(), "node_modules/.bin/tsx"), "src/server.ts"],
    env: gwEnv,
    logFile: gwLogFile,
  });

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
    NODE_ENV: "production",
  };

  const orchPid = spawnService({
    cwd: orchestratorDir(),
    cmd: [join(orchestratorDir(), "node_modules/.bin/tsx"), "src/index.ts"],
    env: orchEnv,
    logFile: orchLogFile,
  });

  // ── Dashboard ──────────────────────────────────────────────────────────────
  const dashLogFile = join(logsDir, "dashboard.log");
  const adminToken = projectEnv.FLOW_ADMIN_TOKEN ?? "flow-dev-token";
  const dashEnv = {
    ...projectEnv,
    ORCHESTRATOR_URL: `http://localhost:${ports.orchestrator}`,
    GATEWAY_URL: `http://localhost:${ports.gateway}`,
    FLOW_ADMIN_TOKEN: adminToken,
    FLOW_MODE: mode, // local → dashboard auto-authenticates (no login step); prod → token required
    REPOS_JSON_PATH: reposJsonPath,
    PORT: String(ports.dashboard),
    NODE_ENV: "production",
  };

  // The shared production build was ensured once in cmdUp; each project just
  // runs `next start -p <port>` against it.
  const dashPid = spawnService({
    cwd: dashboardDir(),
    cmd: [join(dashboardDir(), "node_modules/.bin/next"), "start", "--port", String(ports.dashboard)],
    env: dashEnv,
    logFile: dashLogFile,
  });

  writePids(name, { gateway: gwPid, orchestrator: orchPid, dashboard: dashPid });

  // ── Wait for health ─────────────────────────────────────────────────────────
  const [gwOk, orchOk, dashOk] = await Promise.all([
    waitForHealth(`http://localhost:${ports.gateway}/health`, 25000),
    waitForHealth(`http://localhost:${ports.orchestrator}/health`, 25000),
    waitForHealth(`http://localhost:${ports.dashboard}/login`, 45000),
  ]);

  if (gwOk && orchOk && dashOk) {
    finish(`${OK} ${c.dim("ready")}       ${c.cyan(dashUrl)}`);
    return { name, ok: true, ports, mode };
  }

  const failed = [!gwOk && "gateway", !orchOk && "orchestrator", !dashOk && "dashboard"].filter(Boolean);
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
  console.log("");
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
  // still holds each project port.
  const project = readProject(name);
  if (project?.ports) {
    for (const port of Object.values(project.ports)) {
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

      const dashUrl = `http://localhost:${ports.dashboard}`;
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

  for (const { name, project } of projects) {
    const { ports } = project;
    const base = `http://localhost:${ports.dashboard}`;
    const problems = [];

    if (!(await probe(`http://localhost:${ports.gateway}/health`, 2500))) problems.push("gateway down");
    if (!(await probe(`http://localhost:${ports.orchestrator}/health`, 2500))) problems.push("orchestrator down");

    // Dashboard home + asset check.
    const home = await fetchStatus(`${base}/`, { wantText: true });
    if (home.status === 0) {
      problems.push("dashboard down");
    } else if (home.status >= 500) {
      problems.push(`home ${home.status}`);
    } else if (home.text) {
      const assets = [...home.text.matchAll(/\/_next\/static\/[^"']+\.(?:css|js)/g)].map((m) => m[0]).slice(0, 4);
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

    // Every page reachable (flag only crashes/unreachable — a 3xx auth redirect
    // in prod is fine, not a failure).
    for (const path of DOCTOR_PAGES) {
      const r = await fetchStatus(`${base}${path}`);
      if (r.status === 0 || r.status >= 500) problems.push(`${path} ${r.status || "unreachable"}`);
    }

    const label = c.bold(name.padEnd(16));
    if (problems.length === 0) {
      console.log(`  ${label} ${OK} ${c.dim("pages + assets OK")}   ${c.cyan(base)}`);
    } else {
      anyFail = true;
      console.log(`  ${label} ${FAIL} ${c.red(problems.slice(0, 5).join(", "))}`);
    }
  }
  console.log("");
  if (anyFail) {
    console.log(c.dim("  If assets are stale, run  flow up  — it now refreshes running dashboards after a rebuild.\n"));
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
  await downProject(name);
  rmSync(projectDir(name), { recursive: true, force: true });
  console.log(`  ${OK} removed ${c.bold(name)}\n`);
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

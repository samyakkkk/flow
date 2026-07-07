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
  openSync,
  closeSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

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
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
}

function printHelp() {
  console.log(`
flow — Multi-project CLI for the Flow knowledge-graph agent system

Usage:
  flow project create <name> [--mode local|prod]
  flow up [name]               Start project(s). No name = all.
  flow down [name]             Stop project(s). No name = all.
  flow ls                      Table of all projects + status.
  flow --help

Options:
  --mode <mode>    local (default) or prod

Examples:
  flow project create acme
  flow up acme
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
  if (!stale) return;
  console.log("  [dashboard] building (shared across projects — first run takes ~30s)...");
  const res = spawnSync(join(dir, "node_modules/.bin/next"), ["build"], {
    cwd: dir,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (res.status !== 0) throw new Error("dashboard build failed — run `npm run build` in dashboard/ to see why");
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

async function cmdProjectCreate(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      graph: { type: "string" },
      mode: { type: "string", default: "local" },
    },
  });

  const name = positionals[0];
  if (!name) die("Usage: flow project create <name> [--graph <g>] [--mode local|prod]");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) die(`Invalid project name "${name}" — use only letters, digits, _ and -`);

  const mode = values.mode === "prod" ? "prod" : "local";
  const graphName = values.graph ?? name;

  // Determine project index for port assignment
  const existingNames = listProjectNames();
  if (existingNames.includes(name)) {
    die(`Project "${name}" already exists at ${projectDir(name)}`);
  }

  // Check for port conflicts among existing projects
  const allIdx = existingNames.length; // new project gets next index
  const ports = portsForIndex(allIdx);

  // Check port collision with existing projects
  for (const existing of listProjects()) {
    const ep = existing.project.ports;
    if (
      ep.gateway === ports.gateway ||
      ep.orchestrator === ports.orchestrator ||
      ep.dashboard === ports.dashboard
    ) {
      die(
        `Port conflict with project "${existing.name}": ` +
          `gateway=${ep.gateway}, orchestrator=${ep.orchestrator}, dashboard=${ep.dashboard}. ` +
          `These overlap with the new project's ports (g=${ports.gateway}, o=${ports.orchestrator}, d=${ports.dashboard}).`
      );
    }
  }

  const dir = projectDir(name);
  const workspaceDir = join(dir, "workspace");
  const logsDir = join(dir, "logs");

  mkdirSync(dir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  // project.json
  const projectData = {
    name,
    graph: graphName,
    mode,
    ports,
    repos: [],
  };
  writeProject(name, projectData);

  // .env — a strong admin token is generated per project (this is the dashboard
  // login + API bearer). The rest are commented until the user adds them.
  const adminToken = randomBytes(24).toString("hex");
  const envTemplate = `# Project: ${name}
# Secrets merged into the environment on "flow up ${name}". Never commit this file.
#
# Dashboard login + API bearer (auto-generated — keep it secret):
FLOW_ADMIN_TOKEN=${adminToken}
#
# Add integration keys as you connect them:
# SLACK_BOT_TOKEN=        # prod-mode only
# SLACK_APP_TOKEN=        # prod-mode only
# LINEAR_API_KEY=
# OPENROUTER_API_KEY=
# GITHUB_TOKEN=
`;
  writeFileSync(join(dir, ".env"), envTemplate, { encoding: "utf-8", mode: 0o600 });

  // workspace/.opencode — copy from index-workspace template
  const templateOpencode = join(indexWorkspaceDir(), ".opencode");
  const destOpencode = join(workspaceDir, ".opencode");
  if (existsSync(templateOpencode)) {
    cpSync(templateOpencode, destOpencode, { recursive: true });
  } else {
    mkdirSync(destOpencode, { recursive: true });
    console.warn(`  [warn] index-workspace/.opencode not found — empty .opencode created`);
  }

  // workspace/AGENTS.md — copy from index-workspace template
  const templateAgentsMd = join(indexWorkspaceDir(), "AGENTS.md");
  if (existsSync(templateAgentsMd)) {
    const agentsMdContent = readFileSync(templateAgentsMd, "utf-8");
    writeFileSync(join(workspaceDir, "AGENTS.md"), agentsMdContent, "utf-8");
  }

  // workspace/repos.json — empty registry
  writeFileSync(
    join(workspaceDir, "repos.json"),
    JSON.stringify({ repos: [] }, null, 2) + "\n",
    "utf-8"
  );

  console.log(`\nCreated project "${name}":`);
  console.log(`  dir:          ${dir}`);
  console.log(`  graph:        ${graphName}`);
  console.log(`  mode:         ${mode}`);
  console.log(`  ports:        gateway=${ports.gateway}  orchestrator=${ports.orchestrator}  dashboard=${ports.dashboard}`);
  console.log(`  admin token:  ${adminToken}   ← dashboard login (also in ${join(dir, ".env")})`);
  console.log(`\nNext: flow up ${name}`);
}

// ── COMMAND: up ───────────────────────────────────────────────────────────────

async function cmdUp(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const targetName = positionals[0] ?? null;

  const names = targetName ? [targetName] : listProjectNames();
  if (names.length === 0) die("No projects found. Run: flow project create <name>");

  // Validate all named projects exist
  for (const n of names) {
    if (!existsSync(projectJsonPath(n))) die(`Project "${n}" not found.`);
  }

  // Ensure FalkorDB is running
  console.log("\n[flow up] Ensuring FalkorDB container is running...");
  await ensureFalkordb();

  for (const name of names) {
    await upProject(name);
  }
}

async function upProject(name) {
  console.log(`\n[flow up] ${name}`);
  const project = readProject(name);
  const dir = projectDir(name);
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });

  const { ports, graph, mode } = project;

  // Check if already running (pidfile + health check)
  const pids = readPids(name);
  if (pids.orchestrator && isAlive(pids.orchestrator)) {
    const orchHealth = `http://localhost:${ports.orchestrator}/health`;
    const healthy = await probe(orchHealth);
    if (healthy) {
      console.log(`  [${name}] Already running (orchestrator pid ${pids.orchestrator}). Use "flow down ${name}" first to restart.`);
      return;
    }
    // Stale pidfile — clean up
    console.log(`  [${name}] Stale pidfile detected — cleaning up...`);
  }

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
  console.log(`  [${name}] gateway  pid=${gwPid}  port=${ports.gateway}  log=${gwLogFile}`);

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
  console.log(`  [${name}] orchestrator  pid=${orchPid}  port=${ports.orchestrator}  log=${orchLogFile}`);

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

  // Dashboards run `next start` against ONE shared production build: Next.js
  // allows only a single `next dev` per directory, so dev mode cannot serve
  // multiple projects side-by-side. Build once (or when the source changed),
  // then any number of `next start -p <port>` instances share it.
  ensureDashboardBuild();
  const dashPid = spawnService({
    cwd: dashboardDir(),
    cmd: [join(dashboardDir(), "node_modules/.bin/next"), "start", "--port", String(ports.dashboard)],
    env: dashEnv,
    logFile: dashLogFile,
  });
  console.log(`  [${name}] dashboard  pid=${dashPid}  port=${ports.dashboard}  log=${dashLogFile}`);

  // Write pids
  writePids(name, { gateway: gwPid, orchestrator: orchPid, dashboard: dashPid });

  // ── Wait for health checks ─────────────────────────────────────────────────
  console.log(`  [${name}] Waiting for services to be healthy...`);

  const gwUrl = `http://localhost:${ports.gateway}/health`;
  const orchUrl = `http://localhost:${ports.orchestrator}/health`;
  const dashUrl = `http://localhost:${ports.dashboard}/login`;

  const [gwOk, orchOk, dashOk] = await Promise.all([
    waitForHealth(gwUrl, 25000),
    waitForHealth(orchUrl, 25000),
    waitForHealth(dashUrl, 45000),
  ]);

  if (!gwOk) {
    console.error(`  [${name}] WARNING: gateway did not become healthy (check ${gwLogFile})`);
  } else {
    console.log(`  [${name}] gateway  HEALTHY`);
  }

  if (!orchOk) {
    console.error(`  [${name}] WARNING: orchestrator did not become healthy (check ${orchLogFile})`);
  } else {
    console.log(`  [${name}] orchestrator  HEALTHY`);
  }

  if (!dashOk) {
    console.error(`  [${name}] WARNING: dashboard did not become healthy (check ${dashLogFile})`);
  } else {
    console.log(`  [${name}] dashboard  HEALTHY`);
  }

  console.log(`\n  [${name}] Dashboard: http://localhost:${ports.dashboard}`);
  console.log(`  [${name}] Orchestrator: http://localhost:${ports.orchestrator}`);
}

// ── COMMAND: down ─────────────────────────────────────────────────────────────

async function cmdDown(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const targetName = positionals[0] ?? null;

  const names = targetName ? [targetName] : listProjectNames();
  if (names.length === 0) {
    console.log("No projects found.");
    return;
  }

  for (const name of names) {
    await downProject(name);
  }
}

async function downProject(name) {
  console.log(`\n[flow down] ${name}`);
  const pids = readPids(name);

  const services = ["gateway", "orchestrator", "dashboard"];
  let anyKilled = false;

  for (const svc of services) {
    const pid = pids[svc];
    if (!pid) {
      console.log(`  [${name}] ${svc} — no pid recorded`);
      continue;
    }
    if (!isAlive(pid)) {
      console.log(`  [${name}] ${svc} pid=${pid} — already stopped`);
      continue;
    }
    // SIGTERM first
    try {
      process.kill(pid, "SIGTERM");
      console.log(`  [${name}] ${svc} pid=${pid} — SIGTERM sent`);
      anyKilled = true;
    } catch (e) {
      console.log(`  [${name}] ${svc} pid=${pid} — could not kill: ${e.message}`);
    }
  }

  if (anyKilled) {
    // Give processes 3s to exit, then SIGKILL survivors
    await new Promise((r) => setTimeout(r, 3000));
    for (const svc of services) {
      const pid = pids[svc];
      if (!pid) continue;
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
          console.log(`  [${name}] ${svc} pid=${pid} — SIGKILL (didn't exit in time)`);
        } catch {
          // Already gone
        }
      }
    }
  }

  // Port-based fallback: pids.json can go stale (manual restarts, crashes),
  // leaving a service — most painfully the orchestrator — alive after `down`,
  // so the next `up` reuses the old process with old code. Kill whatever still
  // holds each project port.
  const project = readProject(name);
  if (project?.ports) {
    for (const [svc, port] of Object.entries(project.ports)) {
      try {
        const res = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
        const out = (res.stdout ?? "").trim();
        for (const p of out.split("\n").filter(Boolean)) {
          try {
            process.kill(Number(p), "SIGKILL");
            console.log(`  [${name}] ${svc} port ${port} pid=${p} — killed (stale pidfile fallback)`);
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* lsof unavailable — pid-based kill above is best effort */
      }
    }
  }

  // Clear pidfile
  writePids(name, {});
  console.log(`  [${name}] pids cleared`);
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
    if (cmd === "project") {
      const sub = rest[0];
      if (sub === "create") {
        await cmdProjectCreate(rest.slice(1));
      } else {
        die(`Unknown subcommand: project ${sub ?? "(none)"}. Try: flow project create <name>`);
      }
    } else if (cmd === "up") {
      await cmdUp(rest);
    } else if (cmd === "down") {
      await cmdDown(rest);
    } else if (cmd === "ls") {
      await cmdLs();
    } else {
      die(`Unknown command: "${cmd}". Run "flow --help" for usage.`);
    }
  } catch (err) {
    die(err.message);
  }
}

main();

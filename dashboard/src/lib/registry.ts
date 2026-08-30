// Project registry — the single dashboard's map of every Flow project on this
// deployment. Reads data/projects/<name>/{project.json,.env} fresh per lookup
// (with a short mtime-free TTL cache) so `flow project create` shows up
// without a dashboard restart. The per-project FLOW_ADMIN_TOKEN lives here as
// a SERVER-SIDE secret: it is injected into orchestrator/gateway calls and
// never handed to the browser.
import fs from "node:fs";
import path from "node:path";
import { FLOW_DATA_DIR } from "./config";

export interface RegistryProject {
  name: string;
  graph: string;
  mode: "local" | "prod";
  // "runner" is a gateway-less local project `flow connect` stands up to run
  // coding agents against a connected cloud's brain — it has no brain of its
  // own. Everything else is a normal brain-carrying project.
  kind: "project" | "runner";
  dir: string;
  orchestratorUrl: string;
  gatewayUrl: string;
  adminToken: string;
  reposJsonPath: string;
}

const CACHE_TTL_MS = 2000;
let cache: { at: number; projects: Map<string, RegistryProject> } | null = null;

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[trimmed.slice(0, idx).trim()] = val;
  }
  return env;
}

function loadAll(): Map<string, RegistryProject> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.projects;

  const projects = new Map<string, RegistryProject>();
  const root = path.join(FLOW_DATA_DIR, "projects");
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry);
      const jsonPath = path.join(dir, "project.json");
      if (!fs.existsSync(jsonPath)) continue;
      try {
        const p = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as {
          name: string;
          graph: string;
          mode: string;
          kind?: string;
          ports: { gateway: number; orchestrator: number };
        };
        const env = parseEnvFile(path.join(dir, ".env"));
        projects.set(entry, {
          name: entry,
          graph: p.graph ?? entry,
          mode: p.mode === "prod" ? "prod" : "local",
          kind: p.kind === "runner" ? "runner" : "project",
          dir,
          orchestratorUrl: `http://127.0.0.1:${p.ports.orchestrator}`,
          gatewayUrl: `http://127.0.0.1:${p.ports.gateway}`,
          adminToken: env.FLOW_ADMIN_TOKEN ?? "",
          reposJsonPath: path.join(dir, "workspace", "repos.json"),
        });
      } catch {
        // unreadable project.json — skip; flow doctor will surface it
      }
    }
  }
  cache = { at: now, projects };
  return projects;
}

/** All projects, sorted by name. */
export function listRegistryProjects(): RegistryProject[] {
  return [...loadAll().values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One project by name, or null. Names are exact (case-sensitive, like the CLI). */
export function getRegistryProject(name: string): RegistryProject | null {
  return loadAll().get(name) ?? null;
}

// First URL segments that can never be project names (deployment-level
// surfaces + the legacy /p/ prefix). The CLI refuses these at create time;
// checking here too keeps a hand-made project dir from shadowing /login.
export const RESERVED_PROJECT_NAMES = new Set(["login", "api", "p", "_next", "favicon.ico", "data", "logs", "mcp", "connect"]);

/** Valid project-name shape (mirrors the CLI's create validation). */
export function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && !RESERVED_PROJECT_NAMES.has(name);
}

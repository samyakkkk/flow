// lib/paths.mjs — Canonical path helpers relative to flow/ root.

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// flow/ root is two levels up from bin/lib/
const __filename = fileURLToPath(import.meta.url);
const FLOW_ROOT = dirname(dirname(dirname(__filename)));

export const flowRoot = FLOW_ROOT;

/** Absolute path to data/projects/<name> */
export function projectDir(name) {
  return join(FLOW_ROOT, "data", "projects", name);
}

/** Absolute path to data/projects/<name>/project.json */
export function projectJsonPath(name) {
  return join(projectDir(name), "project.json");
}

/** Absolute path to data/projects/<name>/pids.json */
export function pidsJsonPath(name) {
  return join(projectDir(name), "pids.json");
}

/** Absolute path to flow/data/projects/ */
export function projectsRoot() {
  return join(FLOW_ROOT, "data", "projects");
}

/** Absolute path to graph-gateway/ inside flow/ */
export function gatewayDir() {
  return join(FLOW_ROOT, "graph-gateway");
}

/** Absolute path to orchestrator/ inside flow/ */
export function orchestratorDir() {
  return join(FLOW_ROOT, "orchestrator");
}

/** Absolute path to dashboard/ inside flow/ */
export function dashboardDir() {
  return join(FLOW_ROOT, "dashboard");
}

/** Absolute path to index-workspace/ (template for per-project workspaces) */
export function indexWorkspaceDir() {
  return join(FLOW_ROOT, "index-workspace");
}

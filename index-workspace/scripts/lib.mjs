import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACE = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPOS_DIR = join(WORKSPACE, "repos");
export const REGISTRY_PATH = join(WORKSPACE, "repos.json");
export const GATEWAY_URL = process.env.GRAPH_GATEWAY_URL ?? "http://127.0.0.1:7433";
export const MODEL = process.env.GRAPH_BUILDER_MODEL ?? "openrouter/minimax/minimax-m3";

export function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return { repos: [] };
  }
}

export function saveRegistry(registry) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function assertGatewayUp() {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error(`graph-gateway is not reachable at ${GATEWAY_URL} — start it first (cd graph-gateway && npm run dev)`);
    process.exit(1);
  }
}

// Runs one non-interactive graph-builder session in the workspace and streams
// its output. Returns true on success.
export function runBuilder(prompt) {
  console.log(`\n→ opencode run --agent graph-builder -m ${MODEL}\n`);
  const res = spawnSync("opencode", ["run", "--agent", "graph-builder", "-m", MODEL, "--dir", WORKSPACE, prompt], {
    stdio: "inherit",
    env: { ...process.env, GRAPH_GATEWAY_URL: GATEWAY_URL },
  });
  return res.status === 0;
}

export function fullIndexPrompt(name) {
  return `Index the repository at repos/${name} into the knowledge graph.

The graph may already contain entities from other repositories. Before creating anything, check what exists (graph_find / graph_read). Reuse and enrich existing entities, and pay special attention to cross-repo dependencies: if this repo calls an API, table, queue, or bucket that is already modeled, that is where usage contracts belong.

Work through the repo: identify the service(s), API endpoints, capabilities, resources it reads/writes, external dependencies, and the usage contracts for its important dependencies. Write to the graph incrementally as you learn, following your instructions. Finish with a summary of what you modeled, open questions, and low-confidence assumptions.`;
}

export function incrementalPrompt(name, fromCommit, toCommit, stat) {
  return `The repository repos/${name} was updated from ${fromCommit} to ${toCommit}. Changed files:

${stat}

Read the actual diff with git (cd repos/${name} && git diff ${fromCommit}..${toCommit} -- <paths>) for anything that looks behavioral. Decide what changed in *behavior* terms — new/changed/removed capabilities, endpoints, resources, or usage-contract conditions. Refactors that move code without changing behavior need no graph writes.

Update the knowledge graph accordingly: enrich or correct existing entities, update contracts whose uses/sensitive_to conditions changed, add new entities for genuinely new behavior, and update evidence on anything you re-verified. Finish with a short summary of what changed in the graph and why, or state that no durable behavior changed.`;
}

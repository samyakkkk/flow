// Connect a repository to the knowledge graph:
//   node scripts/add-repo.mjs <git-url> [branch] [--skip-index]
// Clones the branch into repos/, registers it in repos.json, and runs a
// graph-builder session to index it into the existing graph.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  REPOS_DIR, assertGatewayUp, fullIndexPrompt, git, loadRegistry, runBuilder, saveRegistry,
} from "./lib.mjs";

const args = process.argv.slice(2).filter((a) => a !== "--skip-index");
const skipIndex = process.argv.includes("--skip-index");
const [url, branchArg] = args;

if (!url) {
  console.error("usage: node scripts/add-repo.mjs <git-url> [branch] [--skip-index]");
  process.exit(1);
}

const name = url.replace(/\/+$/, "").split("/").pop().replace(/\.git$/, "");
const dest = join(REPOS_DIR, name);
const registry = loadRegistry();

if (registry.repos.some((r) => r.name === name)) {
  console.error(`'${name}' is already registered. Use scripts/update.mjs to re-index it.`);
  process.exit(1);
}

if (!existsSync(dest)) {
  console.log(`Cloning ${url}${branchArg ? ` (branch ${branchArg})` : ""} → repos/${name}`);
  const cloneArgs = ["clone", "--single-branch", ...(branchArg ? ["--branch", branchArg] : []), url, dest];
  git(REPOS_DIR, ...cloneArgs);
} else {
  console.log(`repos/${name} already exists, using it as-is`);
}

const branch = branchArg ?? git(dest, "rev-parse", "--abbrev-ref", "HEAD");
const head = git(dest, "rev-parse", "HEAD");

registry.repos.push({ name, url, branch, lastIndexedCommit: null, addedAt: new Date().toISOString() });
saveRegistry(registry);
console.log(`Registered '${name}' (branch ${branch}, HEAD ${head.slice(0, 10)})`);

if (skipIndex) {
  console.log("Skipping index (--skip-index). Run scripts/update.mjs when ready.");
  process.exit(0);
}

await assertGatewayUp();
const ok = runBuilder(fullIndexPrompt(name));
if (ok) {
  const reg = loadRegistry();
  const entry = reg.repos.find((r) => r.name === name);
  entry.lastIndexedCommit = head;
  entry.lastIndexedAt = new Date().toISOString();
  saveRegistry(reg);
  console.log(`\nIndexed '${name}' at ${head.slice(0, 10)}.`);
} else {
  console.error(`\nIndexing run failed; '${name}' stays registered with lastIndexedCommit=null. Re-run via scripts/update.mjs.`);
  process.exit(1);
}

// Bring the knowledge graph up to date with all connected repositories:
//   node scripts/update.mjs [repo-name]
// Pulls each registered repo's branch; repos never indexed get a full index
// run, repos with new commits get an incremental run over the diff. Safe to
// run on a schedule.

import { join } from "node:path";
import {
  REPOS_DIR, assertGatewayUp, fullIndexPrompt, git, incrementalPrompt, loadRegistry, runBuilder, saveRegistry,
} from "./lib.mjs";

const only = process.argv[2];
const registry = loadRegistry();
const targets = registry.repos.filter((r) => !only || r.name === only);

if (targets.length === 0) {
  console.log(only ? `No registered repo named '${only}'.` : "No repos registered. Use scripts/add-repo.mjs first.");
  process.exit(only ? 1 : 0);
}

await assertGatewayUp();

for (const repo of targets) {
  const dir = join(REPOS_DIR, repo.name);
  console.log(`\n=== ${repo.name} ===`);
  git(dir, "fetch", "origin", repo.branch);
  git(dir, "checkout", "-q", repo.branch);
  git(dir, "reset", "--hard", `origin/${repo.branch}`);
  const head = git(dir, "rev-parse", "HEAD");

  let prompt;
  if (!repo.lastIndexedCommit) {
    console.log("Never indexed — running full index.");
    prompt = fullIndexPrompt(repo.name);
  } else if (repo.lastIndexedCommit === head) {
    console.log(`Up to date at ${head.slice(0, 10)} — nothing to do.`);
    continue;
  } else {
    const stat = git(dir, "diff", "--stat", `${repo.lastIndexedCommit}..${head}`);
    console.log(`Changes ${repo.lastIndexedCommit.slice(0, 10)}..${head.slice(0, 10)} — running incremental update.`);
    prompt = incrementalPrompt(repo.name, repo.lastIndexedCommit, head, stat);
  }

  const ok = runBuilder(prompt);
  if (ok) {
    const reg = loadRegistry();
    const entry = reg.repos.find((r) => r.name === repo.name);
    entry.lastIndexedCommit = head;
    entry.lastIndexedAt = new Date().toISOString();
    saveRegistry(reg);
    console.log(`'${repo.name}' indexed at ${head.slice(0, 10)}.`);
  } else {
    console.error(`Run failed for '${repo.name}'; lastIndexedCommit unchanged so it will retry next time.`);
  }
}

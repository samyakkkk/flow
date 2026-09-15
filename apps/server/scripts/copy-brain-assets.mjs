import { mkdir, copyFile } from "node:fs/promises";
import { dirname } from "node:path";
for (const name of ["AGENTS.md", ".opencode/agents/graph-builder.md"]) {
  const source = new URL(`../../../flow-t3/shared/index-workspace/${name}`, import.meta.url);
  const target = new URL(`../dist/brain-assets/${name}`, import.meta.url);
  await mkdir(dirname(target.pathname), { recursive: true });
  await copyFile(source, target);
}

for (const name of [
  "package.json",
  "harness/agent-connector.mjs",
  "harness/cloud-setup.mjs",
  "harness/agent-home.mjs",
  "harness/capture-replay.mjs",
  "harness/flow-hook.mjs",
  "lib/materialize.mjs",
  "lib/executables.mjs",
]) {
  const source = new URL(`../../../flow-t3/shared/bin/${name}`, import.meta.url);
  const target = new URL(`../dist/brain-setup/${name}`, import.meta.url);
  await mkdir(dirname(target.pathname), { recursive: true });
  await copyFile(source, target);
}

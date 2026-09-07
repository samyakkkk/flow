import { mkdir, copyFile } from "node:fs/promises";
import { dirname } from "node:path";
for (const name of ["AGENTS.md", ".opencode/agents/graph-builder.md"]) {
  const source = new URL(`../../../flow/index-workspace/${name}`, import.meta.url);
  const target = new URL(`../dist/brain-assets/${name}`, import.meta.url);
  await mkdir(dirname(target.pathname), { recursive: true });
  await copyFile(source, target);
}

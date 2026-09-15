// @effect-diagnostics nodeBuiltinImport:off - Local project filesystem discovery.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** A chat project may contain several repositories; its plain parent is never an index source. */
export async function projectRepositories(root: string): Promise<string[]> {
  const queue = [{ path: await NodeFSP.realpath(root), depth: 0 }];
  const repositories: string[] = [];
  const ignored = new Set(["node_modules", "vendor", "dist", "build", "target"]);
  let visited = 0;
  while (queue.length) {
    const next = queue.shift()!;
    if (++visited > 5000)
      throw new Error("This folder is too large to scan. Choose a smaller project folder.");
    const entries = await NodeFSP.readdir(next.path, { withFileTypes: true });
    const git = entries.find((entry) => entry.name === ".git");
    if (git) {
      // Linked worktrees are not separate indexing sources.
      if (git.isDirectory()) repositories.push(next.path);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      if (next.depth >= 8)
        throw new Error("This folder is too deeply nested. Choose a smaller project folder.");
      queue.push({ path: NodePath.join(next.path, entry.name), depth: next.depth + 1 });
    }
  }
  return repositories.sort();
}

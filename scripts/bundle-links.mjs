// Directory links inside a Windows bundle. pnpm links workspace packages with
// junctions, and a junction stores an absolute path: archived as-is it would
// point into the build machine. Copying the targets instead is not an option,
// because Node refuses to strip types from TypeScript under node_modules and
// the server runs its workspace packages from source. So the build records
// every link and removes it, and the installer recreates them wherever the
// release ends up (restoreLinks in flow-release.mjs).
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { linkManifest } from "./flow-release.mjs";

const portable = (path) => path.split(NodePath.sep).join("/");

/** Record every link under `root` in the manifest, then remove it. A link to a
    file is replaced by a copy, since only directories can be junctions. */
export async function recordLinks(root) {
  const links = [];
  const visit = async (directory) => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await NodeFSP.realpath(path).catch(() => null);
        const inside = target && !NodePath.relative(root, target).startsWith("..");
        const stat = inside ? await NodeFSP.stat(target) : null;
        // rm without `recursive` removes the link itself, never its target.
        await NodeFSP.rm(path);
        if (stat?.isDirectory())
          links.push({
            path: portable(NodePath.relative(root, path)),
            target: portable(NodePath.relative(NodePath.dirname(path), target)),
          });
        else if (stat) await NodeFSP.copyFile(target, path);
        // A link that dangles or leaves the bundle could never work once
        // installed; dropping it here keeps the failure on the build machine.
      } else if (entry.isDirectory()) await visit(path);
    }
  };
  await visit(root);
  await NodeFSP.writeFile(NodePath.join(root, linkManifest), JSON.stringify(links) + "\n");
  return links.length;
}

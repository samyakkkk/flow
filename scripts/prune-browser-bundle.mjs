/* oxlint-disable t3code/no-global-process-runtime -- Standalone bundle tooling tests the host platform. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";

// Source execution uses workspace packages (some historically declared as dev
// dependencies) and tsx for Brain workers. The browser itself is already built.
export async function pruneBrowserBundle(source) {
  const root = await NodeFSP.realpath(source);
  const store = NodePath.join(root, "node_modules/.pnpm");
  const keep = new Set();
  const containers = new Set();
  async function visit(directory) {
    const real = await NodeFSP.realpath(directory);
    if (!real.startsWith(root + NodePath.sep)) throw Error(`Dependency escapes bundle: ${real}`);
    if (keep.has(real)) return;
    keep.add(real);
    const external = real.startsWith(store + NodePath.sep);
    if (external) containers.add(NodePath.relative(store, real).split(NodePath.sep)[0]);
    const pkg = JSON.parse(await NodeFSP.readFile(NodePath.join(real, "package.json"), "utf8"));
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...(external ? pkg.peerDependencies : {}),
    };
    if (!external) {
      for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
        if ((version.startsWith("workspace:") && name !== "@t3tools/web") || name === "tsx")
          dependencies[name] = version;
      }
    }
    const require = NodeModule.createRequire(NodePath.join(real, "package.json"));
    for (const name of Object.keys(dependencies)) {
      let found;
      for (const modules of require.resolve.paths(name) ||
        require.resolve.paths(`${name}/`) ||
        []) {
        const candidate = NodePath.join(modules, name);
        if (await NodeFSP.stat(NodePath.join(candidate, "package.json")).catch(() => null)) {
          found = candidate;
          break;
        }
      }
      if (found) await visit(found);
      else if (!pkg.optionalDependencies?.[name] && !pkg.peerDependencies?.[name])
        throw Error(`Missing runtime dependency ${pkg.name} → ${name}`);
    }
  }
  for (const workspace of [
    "apps/server",
    "flow-t3/shared/runtime",
    "flow-t3/shared/graph-gateway",
    "flow-t3/shared/orchestrator",
  ]) {
    await visit(NodePath.join(root, workspace));
  }
  let removed = 0;
  for (const entry of await NodeFSP.readdir(store, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "node_modules" && !containers.has(entry.name)) {
      await NodeFSP.rm(NodePath.join(store, entry.name), { recursive: true });
      removed++;
    }
  }
  for (const parent of ["apps", "packages", "flow-t3/shared", "infra"]) {
    for (const entry of await NodeFSP.readdir(NodePath.join(root, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const workspace = NodePath.join(root, parent, entry.name);
      if (!keep.has(workspace))
        await NodeFSP.rm(NodePath.join(workspace, "node_modules"), {
          recursive: true,
          force: true,
        });
    }
  }
  // Build-time links must not point back to removed packages or the build host.
  async function cleanLinks(directory) {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await NodeFSP.realpath(path).catch(() => null);
        if (!resolved) await NodeFSP.unlink(path);
        else if (!resolved.startsWith(root + NodePath.sep))
          throw Error(`External link in bundle: ${path}`);
      } else if (entry.isDirectory()) {
        if (entry.name === ".bin") await NodeFSP.rm(path, { recursive: true });
        else await cleanLinks(path);
      }
    }
  }
  await cleanLinks(NodePath.join(root, "node_modules"));
  for (const workspace of keep)
    if (!workspace.startsWith(store + NodePath.sep)) {
      const modules = NodePath.join(workspace, "node_modules");
      if (await NodeFSP.stat(modules).catch(() => null)) await cleanLinks(modules);
    }
  // node-pty ships other platforms inside the same npm tarball.
  const ptyRequire = NodeModule.createRequire(NodePath.join(root, "apps/server/package.json"));
  const prebuilds = NodePath.join(
    NodePath.dirname(ptyRequire.resolve("node-pty/package.json")),
    "prebuilds",
  );
  for (const entry of await NodeFSP.readdir(prebuilds)) {
    if (entry !== `${NodeOS.platform()}-${NodeOS.arch()}`)
      await NodeFSP.rm(NodePath.join(prebuilds, entry), { recursive: true, force: true });
  }
  console.log(`Kept ${containers.size} runtime packages; removed ${removed} build-only packages.`);
}

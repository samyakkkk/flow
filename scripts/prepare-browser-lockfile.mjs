import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { run } from "./flow-release.mjs";

const excluded = [
  "@node-llama-cpp/linux-x64-cuda",
  "@node-llama-cpp/linux-x64-cuda-ext",
  "@node-llama-cpp/linux-x64-vulkan",
];

export function projectCpuLockfile(lockfile) {
  const projected = structuredClone(lockfile);
  const snapshots = Object.values(projected.snapshots || {});
  const importers = Object.values(projected.importers || {});
  for (const snapshot of [...snapshots, ...importers]) {
    for (const name of excluded) {
      if (snapshot.dependencies?.[name] || snapshot.devDependencies?.[name])
        throw Error(`Cannot exclude required dependency ${name}.`);
      if (snapshot.optionalDependencies) delete snapshot.optionalDependencies[name];
    }
  }
  for (const field of ["packages", "snapshots"]) {
    for (const key of Object.keys(projected[field] || {})) {
      if (excluded.some((name) => key.startsWith(`${name}@`))) delete projected[field][key];
    }
  }
  projected.ignoredOptionalDependencies = [
    ...new Set([...(lockfile.ignoredOptionalDependencies || []), ...excluded]),
  ];
  return projected;
}

// This is a staged, CPU-only projection, never an update to dependency versions.
// Bootstrap the same pure-JS YAML parser pinned in the workspace without needing
// the workspace installed first, and verify its exact lockfile integrity.
export async function prepareCpuLockfile(source, temporary) {
  const parser = NodePath.join(temporary, "yaml");
  await NodeFSP.mkdir(parser);
  const response = await fetch("https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz", {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw Error(`YAML parser download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity =
    "2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==";
  if (NodeCrypto.createHash("sha512").update(bytes).digest("base64") !== integrity)
    throw Error("YAML parser integrity mismatch.");
  const archive = NodePath.join(parser, "yaml.tgz");
  await NodeFSP.writeFile(archive, bytes);
  await run("tar", ["-xzf", archive, "-C", parser], temporary);
  const { default: yaml } = await import(
    NodeURL.pathToFileURL(NodePath.join(parser, "package/dist/index.js"))
  );
  const lockPath = NodePath.join(source, "pnpm-lock.yaml");
  const workspacePath = NodePath.join(source, "pnpm-workspace.yaml");
  const lockfile = projectCpuLockfile(yaml.parse(await NodeFSP.readFile(lockPath, "utf8")));
  const workspace = yaml.parse(await NodeFSP.readFile(workspacePath, "utf8"));
  workspace.ignoredOptionalDependencies = [
    ...new Set([
      ...(workspace.ignoredOptionalDependencies || []),
      ...lockfile.ignoredOptionalDependencies,
    ]),
  ];
  lockfile.ignoredOptionalDependencies = workspace.ignoredOptionalDependencies;
  await NodeFSP.writeFile(lockPath, yaml.stringify(lockfile));
  await NodeFSP.writeFile(workspacePath, yaml.stringify(workspace));
}

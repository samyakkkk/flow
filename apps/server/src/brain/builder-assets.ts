// @effect-diagnostics nodeBuiltinImport:off - Bundled graph-builder assets.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export function builderAsset(name: string): string {
  const packaged = NodePath.join(here, "brain-assets", name);
  return NodeFS.readFileSync(
    NodeFS.existsSync(packaged)
      ? packaged
      : NodePath.resolve(here, "../../../../flow-t3/shared/index-workspace", name),
    "utf8",
  );
}
/**
 * The tsx loader the Brain's TypeScript entry points run under, as the value for
 * Node's `--import`. Resolved the way Node would from the graph gateway, since
 * a hoisted install keeps tsx at the root rather than beside it, and returned
 * as a file URL because `--import` reads a Windows path's drive as a scheme.
 */
export function tsxLoader(): string {
  const gateway = NodePath.resolve(here, "../../../../flow-t3/shared/graph-gateway/package.json");
  const tsx = NodePath.dirname(NodeModule.createRequire(gateway).resolve("tsx/package.json"));
  return NodeURL.pathToFileURL(NodePath.join(tsx, "dist/loader.mjs")).href;
}
export function builderMcpCommand(): { command: string; args: string[] } {
  const packaged = NodePath.join(here, "mcp.mjs");
  if (NodeFS.existsSync(packaged)) return { command: process.execPath, args: [packaged] };
  return {
    command: process.execPath,
    args: [
      "--import",
      tsxLoader(),
      NodePath.resolve(here, "../../../../flow-t3/shared/graph-gateway/src/mcp.ts"),
    ],
  };
}

// @effect-diagnostics nodeBuiltinImport:off - Bundled graph-builder assets.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export function builderAsset(name: string): string {
  const packaged = NodePath.join(here, "brain-assets", name);
  return NodeFS.readFileSync(
    NodeFS.existsSync(packaged)
      ? packaged
      : NodePath.resolve(here, "../../../../flow/index-workspace", name),
    "utf8",
  );
}
export function builderMcpCommand(): { command: string; args: string[] } {
  const packaged = NodePath.join(here, "mcp.mjs");
  if (NodeFS.existsSync(packaged)) return { command: process.execPath, args: [packaged] };
  const tsx = NodePath.resolve(
    here,
    "../../../../flow/graph-gateway/node_modules/tsx/dist/loader.mjs",
  );
  return {
    command: process.execPath,
    args: ["--import", tsx, NodePath.resolve(here, "../../../../flow/graph-gateway/src/mcp.ts")],
  };
}

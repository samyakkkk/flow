#!/usr/bin/env node

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  parseUpdateManifest,
  serializeUpdateManifest,
  type UpdateManifestFile,
} from "./lib/update-manifest.ts";

export function refreshUpdateManifestArtifacts(input: {
  readonly manifestPath: string;
  readonly artifactsDir: string;
  readonly platformLabel: string;
}): void {
  const manifest = parseUpdateManifest(
    NodeFS.readFileSync(input.manifestPath, "utf8"),
    input.manifestPath,
    input.platformLabel,
  );
  const artifactsDir = NodePath.resolve(input.artifactsDir);
  const files = manifest.files.map((entry): UpdateManifestFile => {
    if (NodePath.basename(entry.url) !== entry.url) {
      throw new Error(`Update manifest artifact must be a file name: ${entry.url}`);
    }
    const bytes = NodeFS.readFileSync(NodePath.join(artifactsDir, entry.url));
    return {
      ...entry,
      sha512: NodeCrypto.createHash("sha512").update(bytes).digest("base64"),
      size: bytes.length,
    };
  });

  NodeFS.writeFileSync(
    input.manifestPath,
    serializeUpdateManifest({ ...manifest, files }, { platformLabel: input.platformLabel }),
  );
}

if (import.meta.main) {
  const [manifestPath, artifactsDir, platformLabel = "desktop"] = process.argv.slice(2);
  if (!manifestPath || !artifactsDir) {
    throw new Error(
      "Usage: refresh-update-manifest.ts <manifest-path> <artifacts-dir> [platform-label]",
    );
  }
  refreshUpdateManifestArtifacts({ manifestPath, artifactsDir, platformLabel });
}

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { parseUpdateManifest } from "./lib/update-manifest.ts";
import { refreshUpdateManifestArtifacts } from "./refresh-update-manifest.ts";

it("refreshes updater metadata after a distribution artifact changes", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "flow-update-manifest-"));
  const manifestPath = NodePath.join(dir, "latest-mac.yml");
  const artifactName = "Flow-0.1.2-arm64.dmg";
  const finalBytes = Buffer.from("stapled-dmg-bytes");
  NodeFS.writeFileSync(NodePath.join(dir, artifactName), finalBytes);
  NodeFS.writeFileSync(
    manifestPath,
    `version: 0.1.2
files:
  - url: ${artifactName}
    sha512: stale
    size: 1
releaseDate: '2026-09-11T16:08:34.626Z'
`,
  );

  refreshUpdateManifestArtifacts({
    manifestPath,
    artifactsDir: dir,
    platformLabel: "macOS",
  });

  const refreshed = parseUpdateManifest(
    NodeFS.readFileSync(manifestPath, "utf8"),
    manifestPath,
    "macOS",
  );
  assert.deepStrictEqual(refreshed.files, [
    {
      url: artifactName,
      sha512: NodeCrypto.createHash("sha512").update(finalBytes).digest("base64"),
      size: finalBytes.length,
    },
  ]);
});

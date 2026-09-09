#!/usr/bin/env bash
set -euo pipefail

# Bootstrap the release installer without a Git checkout. Release payloads are
# downloaded from GitHub Releases and checksum-verified before extraction.
command -v node >/dev/null || { echo 'Install Node.js 24.13.1+ (24.x) first.' >&2; exit 1; }
for FLOW_TOOL in npm curl tar; do
  command -v "$FLOW_TOOL" >/dev/null || { echo "Install $FLOW_TOOL first." >&2; exit 1; }
done
FLOW_INSTALL_TEMP=$(mktemp -d)
trap 'rm -rf "$FLOW_INSTALL_TEMP"' EXIT
curl --fail --silent --show-error --location \
  https://github.com/samyakkkk/flow/releases/latest/download/flow-release.mjs \
  --output "$FLOW_INSTALL_TEMP/flow-release.mjs"
node "$FLOW_INSTALL_TEMP/flow-release.mjs" install "$@"

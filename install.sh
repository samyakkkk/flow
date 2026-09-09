#!/usr/bin/env bash
set -euo pipefail

# Download a ready-built browser app, including its private Node runtime.
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'The ready-built Flow installer currently supports Apple Silicon Macs with macOS 15+.' >&2
  exit 1
fi
if [ "$(sw_vers -productVersion | cut -d. -f1)" -lt 15 ]; then
  echo 'Flow requires macOS 15 or newer.' >&2
  exit 1
fi
for FLOW_TOOL in curl tar shasum; do
  command -v "$FLOW_TOOL" >/dev/null || { echo "Missing system tool: $FLOW_TOOL" >&2; exit 1; }
done
export FLOW_RELEASE_HOME="${FLOW_RELEASE_HOME:-$HOME/.local/share/flow-browser}"
mkdir -p "$FLOW_RELEASE_HOME"
FLOW_RELEASE_HOME=$(cd "$FLOW_RELEASE_HOME" && pwd -P)
export FLOW_RELEASE_HOME
FLOW_INSTALL_TEMP=$(mktemp -d "$FLOW_RELEASE_HOME/.bootstrap.XXXXXX")
trap 'rm -rf "$FLOW_INSTALL_TEMP"' EXIT
FLOW_ASSET=flow-browser-darwin-arm64.tar.gz
FLOW_URL=https://github.com/samyakkkk/flow/releases/latest/download
printf 'Downloading Flow for Apple Silicon Mac (Node is included)…\n'
curl --fail --show-error --location --retry 2 --connect-timeout 20 --max-time 900 \
  "$FLOW_URL/$FLOW_ASSET" --output "$FLOW_INSTALL_TEMP/$FLOW_ASSET"
curl --fail --silent --show-error --location --retry 2 --connect-timeout 20 --max-time 60 \
  "$FLOW_URL/$FLOW_ASSET.sha256" --output "$FLOW_INSTALL_TEMP/$FLOW_ASSET.sha256"
read -r FLOW_SHA FLOW_CHECKSUM_NAME < "$FLOW_INSTALL_TEMP/$FLOW_ASSET.sha256"
[ "$FLOW_CHECKSUM_NAME" = "$FLOW_ASSET" ] || { echo 'Invalid Flow checksum filename.' >&2; exit 1; }
(cd "$FLOW_INSTALL_TEMP" && shasum -a 256 -c "$FLOW_ASSET.sha256")
printf 'Installing Flow…\n'
mkdir "$FLOW_INSTALL_TEMP/bundle"
tar -xzf "$FLOW_INSTALL_TEMP/$FLOW_ASSET" -C "$FLOW_INSTALL_TEMP/bundle"
"$FLOW_INSTALL_TEMP/bundle/runtime/bin/node" \
  "$FLOW_INSTALL_TEMP/bundle/scripts/flow-release.mjs" install-bundle \
  "$FLOW_INSTALL_TEMP/bundle" "$FLOW_SHA" "$@"

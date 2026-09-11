#!/bin/sh
# Run inside the recipient container as its unprivileged user.
set -eu
for tool in node npm git brew gcc make python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "Unexpected host prerequisite: $tool" >&2
    exit 1
  fi
done
export FLOW_RELEASE_HOME="$HOME/.local/share/flow-browser"
export FLOW_AUTO_UPDATE=0
mkdir -p "$FLOW_RELEASE_HOME"
FLOW_BOOTSTRAP=$(mktemp -d "$FLOW_RELEASE_HOME/.bootstrap.XXXXXX")
trap 'rm -rf "$FLOW_BOOTSTRAP"' EXIT
FLOW_ASSET=flow-browser-linux-x64.tar.gz
read -r FLOW_SHA FLOW_NAME < "/downloads/$FLOW_ASSET.sha256"
[ "$FLOW_NAME" = "$FLOW_ASSET" ]
(cd /downloads && sha256sum -c "$FLOW_ASSET.sha256")
mkdir "$FLOW_BOOTSTRAP/bundle"
tar -xzf "/downloads/$FLOW_ASSET" -C "$FLOW_BOOTSTRAP/bundle"
"$FLOW_BOOTSTRAP/bundle/runtime/bin/node" \
  "$FLOW_BOOTSTRAP/bundle/scripts/flow-release.mjs" install-bundle \
  "$FLOW_BOOTSTRAP/bundle" "$FLOW_SHA"
"$FLOW_RELEASE_HOME/current/runtime/bin/node" \
  "$FLOW_RELEASE_HOME/current/scripts/verify-browser-runtime.mjs" \
  "$FLOW_RELEASE_HOME/current"
"$HOME/.local/bin/flow" --no-open
"$HOME/.local/bin/flow" status

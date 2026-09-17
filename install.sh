#!/usr/bin/env bash
set -euo pipefail

# Validate options before changing any existing installation.
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "${1:-}" != --prefix ]; }; then
  echo 'Usage: install.sh [--prefix DIRECTORY]' >&2
  exit 1
fi
FLOW_CLEANUP_PATH="$PATH"
if [ "$#" -eq 2 ]; then
  mkdir -p "$2/bin"
  FLOW_CLEANUP_PATH="$(cd "$2/bin" && pwd -P):$PATH"
fi

# Download the ready-built Flow CLI, including its private Node runtime.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) FLOW_TARGET=darwin-arm64 ;;
  Linux-x86_64) FLOW_TARGET=linux-x64 ;;
  *) echo 'The Flow CLI supports Apple Silicon macOS 15+ and Linux x64.' >&2; exit 1 ;;
esac
if [ "$FLOW_TARGET" = darwin-arm64 ] && [ "$(sw_vers -productVersion | cut -d. -f1)" -lt 15 ]; then
  echo 'Flow requires macOS 15 or newer.' >&2
  exit 1
fi
for FLOW_TOOL in curl tar; do
  command -v "$FLOW_TOOL" >/dev/null || { echo "Missing system tool: $FLOW_TOOL" >&2; exit 1; }
done
if command -v sha256sum >/dev/null; then FLOW_SHASUM='sha256sum'; else FLOW_SHASUM='shasum -a 256'; fi
# One Flow install per machine; one made by the retired Cloud CLI installer is
# adopted where it is. Keep this order in step with resolveReleaseHome in flow-release.mjs.
if [ -z "${FLOW_RELEASE_HOME:-}" ]; then
  FLOW_RELEASE_HOME="$HOME/.local/share/flow-browser"
  for FLOW_NAME in flow-browser flow-cloud-cli; do
    if [ -e "$HOME/.local/share/$FLOW_NAME/current" ]; then
      FLOW_RELEASE_HOME="$HOME/.local/share/$FLOW_NAME"
      break
    fi
  done
fi
mkdir -p "$FLOW_RELEASE_HOME"
FLOW_RELEASE_HOME=$(cd "$FLOW_RELEASE_HOME" && pwd -P)
export FLOW_RELEASE_HOME
FLOW_INSTALL_TEMP=$(mktemp -d "$FLOW_RELEASE_HOME/.bootstrap.XXXXXX")
trap 'rm -rf "$FLOW_INSTALL_TEMP"' EXIT
FLOW_ASSET="flow-browser-$FLOW_TARGET.tar.gz"
# The copy attached to a release is pinned to it; the repository copy follows the latest CLI release.
FLOW_VERSION='__FLOW_CLI_VERSION__'
case "$FLOW_VERSION" in
  *[!0-9.]*|'') FLOW_URL=https://github.com/samyakkkk/flow/releases/latest/download ;;
  *) FLOW_URL="https://github.com/samyakkkk/flow/releases/download/flow-v$FLOW_VERSION" ;;
esac
printf 'Downloading the Flow CLI (Node is included)…\n'
curl --fail --show-error --location --retry 2 --connect-timeout 20 --max-time 900 \
  "$FLOW_URL/$FLOW_ASSET" --output "$FLOW_INSTALL_TEMP/$FLOW_ASSET"
curl --fail --silent --show-error --location --retry 2 --connect-timeout 20 --max-time 60 \
  "$FLOW_URL/$FLOW_ASSET.sha256" --output "$FLOW_INSTALL_TEMP/$FLOW_ASSET.sha256"
read -r FLOW_SHA FLOW_CHECKSUM_NAME < "$FLOW_INSTALL_TEMP/$FLOW_ASSET.sha256"
[ "$FLOW_CHECKSUM_NAME" = "$FLOW_ASSET" ] || { echo 'Invalid Flow checksum filename.' >&2; exit 1; }
(cd "$FLOW_INSTALL_TEMP" && $FLOW_SHASUM -c "$FLOW_ASSET.sha256")
printf 'Installing Flow…\n'
mkdir "$FLOW_INSTALL_TEMP/bundle"
tar -xzf "$FLOW_INSTALL_TEMP/$FLOW_ASSET" -C "$FLOW_INSTALL_TEMP/bundle"
# Legacy Flow was a Mac developer install; never stop services on a Linux host.
if [ "$FLOW_TARGET" = darwin-arm64 ]; then
  # The standalone cleanup also supports released bundles that predate it.
  FLOW_CLEANUP_SHA=429207617d3c3a7cd73e007a1e8afa4e6d0a8d2cbf5b68fd4403d756ba15e05b
  curl --fail --silent --show-error --location --retry 2 --connect-timeout 20 --max-time 60 \
    https://raw.githubusercontent.com/samyakkkk/flow/9a8481fdc6b87e4fe492d44ddfa686d2f966ef3a/scripts/retire-legacy-flow.mjs \
    --output "$FLOW_INSTALL_TEMP/retire-legacy-flow.mjs"
  printf '%s  retire-legacy-flow.mjs\n' "$FLOW_CLEANUP_SHA" > "$FLOW_INSTALL_TEMP/cleanup.sha256"
  (cd "$FLOW_INSTALL_TEMP" && $FLOW_SHASUM -c cleanup.sha256)
  printf 'Checking for old Flow installations…\n'
  PATH="$FLOW_CLEANUP_PATH" "$FLOW_INSTALL_TEMP/bundle/runtime/bin/node" \
    "$FLOW_INSTALL_TEMP/retire-legacy-flow.mjs"
fi
"$FLOW_INSTALL_TEMP/bundle/runtime/bin/node" \
  "$FLOW_INSTALL_TEMP/bundle/scripts/flow-release.mjs" install-bundle \
  "$FLOW_INSTALL_TEMP/bundle" "$FLOW_SHA" "$@"

# `<home>/bin/flow` always exists; the command on PATH is taken only when it is
# free, so tell people which one actually works for them.
FLOW_LAUNCHER="$FLOW_RELEASE_HOME/bin/flow"
FLOW_RUN="$FLOW_LAUNCHER"
if FLOW_ON_PATH=$(command -v flow 2>/dev/null) &&
  grep -q '# flow-managed-launcher' "$FLOW_ON_PATH" 2>/dev/null; then
  FLOW_RUN=flow
fi

cat <<EOF

Flow is installed.

Start it any time with:
  $FLOW_RUN                 open Flow in your browser
  $FLOW_RUN --no-open       print the link instead of opening a browser
  $FLOW_RUN status | stop | update | --help

Then, in the browser:
  1. Connect this computer.
  2. Create your Brain and choose the coding agent that processes your
     conversations — Claude Code, Codex or OpenCode.
  3. Pick the projects it should know. Flow indexes their repositories and
     connects your coding agents to that Brain, so they can orient themselves
     from it in every session.
EOF
if [ "$FLOW_RUN" != flow ]; then
  printf '\nAdd %s to your PATH to run it as `flow`.\n' "$(dirname "$FLOW_LAUNCHER")"
fi

# Only offer to open a browser for someone sitting at a terminal: a coding agent
# or a script running this installer should just get the instructions.
if [ -t 1 ]; then
  printf '\nStarting Flow…\n'
  "$FLOW_LAUNCHER"
fi

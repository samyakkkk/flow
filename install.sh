#!/usr/bin/env bash
set -euo pipefail

# Validate options before changing any existing installation. A Cloud dashboard
# hands out this command with its own --cloud options appended, so one paste
# installs Flow and connects it to that Brain.
FLOW_USAGE='Usage: install.sh [--prefix DIRECTORY] [--cloud URL --cloud-brain ID --enrollment CREDENTIAL]'
FLOW_PREFIX_ARGS=()
FLOW_CLOUD=; FLOW_CLOUD_BRAIN=; FLOW_ENROLLMENT=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || { echo "$FLOW_USAGE" >&2; exit 1; }
  case "$1" in
    --prefix) FLOW_PREFIX_ARGS=(--prefix "$2") ;;
    --cloud) FLOW_CLOUD=$2 ;;
    --cloud-brain) FLOW_CLOUD_BRAIN=$2 ;;
    --enrollment) FLOW_ENROLLMENT=$2 ;;
    *) echo "$FLOW_USAGE" >&2; exit 1 ;;
  esac
  shift 2
done
if [ -n "$FLOW_CLOUD$FLOW_CLOUD_BRAIN$FLOW_ENROLLMENT" ]; then
  case "$FLOW_CLOUD" in https://?*) ;; *) echo 'The Cloud URL must start with https://.' >&2; exit 1 ;; esac
  case "$FLOW_CLOUD_BRAIN" in ''|*[!A-Za-z0-9-]*) echo 'Copy the whole command from your Cloud dashboard: the Brain ID is missing.' >&2; exit 1 ;; esac
  case "$FLOW_ENROLLMENT" in ''|*[!a-f0-9]*) echo 'Copy the whole command from your Cloud dashboard: the setup credential is missing.' >&2; exit 1 ;; esac
fi
FLOW_CLEANUP_PATH="$PATH"
if [ "${#FLOW_PREFIX_ARGS[@]}" -eq 2 ]; then
  mkdir -p "${FLOW_PREFIX_ARGS[1]}/bin"
  FLOW_CLEANUP_PATH="$(cd "${FLOW_PREFIX_ARGS[1]}/bin" && pwd -P):$PATH"
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
    --disable-warning=ExperimentalWarning "$FLOW_INSTALL_TEMP/retire-legacy-flow.mjs"
fi
"$FLOW_INSTALL_TEMP/bundle/runtime/bin/node" --disable-warning=ExperimentalWarning \
  "$FLOW_INSTALL_TEMP/bundle/scripts/flow-release.mjs" install-bundle \
  "$FLOW_INSTALL_TEMP/bundle" "$FLOW_SHA" ${FLOW_PREFIX_ARGS[@]+"${FLOW_PREFIX_ARGS[@]}"}

# Colour only for a terminal that wants it (https://no-color.org).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  FLOW_BOLD=$(printf '\033[1m'); FLOW_DIM=$(printf '\033[2m'); FLOW_CYAN=$(printf '\033[36m')
  FLOW_GREEN=$(printf '\033[32m'); FLOW_OFF=$(printf '\033[0m')
else
  FLOW_BOLD=; FLOW_DIM=; FLOW_CYAN=; FLOW_GREEN=; FLOW_OFF=
fi

# `<home>/bin/flow` always exists; the command on PATH is taken only when it is
# free, so tell people which one actually works for them.
FLOW_LAUNCHER="$FLOW_RELEASE_HOME/bin/flow"
FLOW_RUN="$FLOW_LAUNCHER"
if FLOW_ON_PATH=$(command -v flow 2>/dev/null) &&
  grep -q '# flow-managed-launcher' "$FLOW_ON_PATH" 2>/dev/null; then
  FLOW_RUN=flow
fi

# Connect the Brain the dashboard named. Its credential works once and for ten
# minutes, so it goes through a private file and is never printed.
FLOW_CONNECTED=
if [ -n "$FLOW_CLOUD" ]; then
  printf 'Connecting this computer to %s…\n' "$FLOW_CLOUD"
  (umask 077 && printf %s "$FLOW_ENROLLMENT" > "$FLOW_INSTALL_TEMP/enrollment")
  if "$FLOW_LAUNCHER" setup --cloud "$FLOW_CLOUD" --cloud-brain "$FLOW_CLOUD_BRAIN" \
    --enrollment-file "$FLOW_INSTALL_TEMP/enrollment" --harness detected >/dev/null; then
    FLOW_CONNECTED=yes
  else
    FLOW_CONNECTED=no
  fi
  rm -f "$FLOW_INSTALL_TEMP/enrollment"
fi

cat <<EOF

${FLOW_GREEN}Flow is installed.${FLOW_OFF}

${FLOW_BOLD}Start it any time with:${FLOW_OFF}
  ${FLOW_CYAN}$FLOW_RUN${FLOW_OFF}                 open Flow in your browser
  ${FLOW_CYAN}$FLOW_RUN --no-open${FLOW_OFF}       print the link instead of opening a browser
  ${FLOW_DIM}$FLOW_RUN status | stop | update | --help${FLOW_OFF}

EOF
if [ "$FLOW_CONNECTED" = yes ]; then
  cat <<EOF
${FLOW_BOLD}Connected to your team's Brain at $FLOW_CLOUD.${FLOW_OFF}
  Restart your coding agents and approve Flow's prompts once. In a checkout of
  any repository that Brain knows, they start every session with its memory.
EOF
elif [ "$FLOW_CONNECTED" = no ]; then
  cat <<EOF >&2
${FLOW_BOLD}Connecting to $FLOW_CLOUD did not work${FLOW_OFF} (see the message above).
  The command from the dashboard works once and for ten minutes: copy a new one
  and run it again. Flow itself is installed and will be reused.
EOF
  exit 1
else
  cat <<EOF
${FLOW_BOLD}Then, in the browser:${FLOW_OFF}
  1. Connect this computer.
  2. Create your Brain and choose the coding agent that processes your
     conversations — Claude Code, Codex or OpenCode.
  3. Pick the projects it should know. Flow indexes their repositories and
     connects your coding agents to that Brain, so they can orient themselves
     from it in every session.
EOF
fi
if [ "$FLOW_RUN" != flow ]; then
  printf '\n%sAdd %s to your PATH to run it as `flow`.%s\n' "$FLOW_BOLD" "$(dirname "$FLOW_LAUNCHER")" "$FLOW_OFF"
fi

# Only offer to open a browser for someone sitting at a terminal: a coding agent
# or a script running this installer should just get the instructions.
if [ -t 1 ]; then
  printf '\n%sStarting Flow…%s\n' "$FLOW_DIM" "$FLOW_OFF"

  "$FLOW_LAUNCHER"
fi

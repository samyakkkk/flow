#!/bin/sh
set -eu
umask 077
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Linux-x86_64) target=linux-x64 ;;
  *) echo 'Cloud CLI requires Apple Silicon macOS or Linux x64.' >&2; exit 1 ;;
esac
version='__FLOW_CLOUD_CLI_VERSION__'
case "$version" in *[!0-9.]*|'') echo 'Cloud CLI has not been published for this dashboard.' >&2; exit 1 ;; esac
base="https://github.com/samyakkkk/flow/releases/download/flow-cloud-cli-v$version"
asset="flow-browser-$target.tar.gz"
# Keep staging on the destination filesystem so adoption is an atomic rename.
install_home="$HOME/.local/share/flow-cloud-cli"
mkdir -p "$install_home"
staging=$(mktemp -d "$install_home/.install.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
curl -fL --retry 2 "$base/$asset" -o "$staging/$asset"
curl -fL --retry 2 "$base/$asset.sha256" -o "$staging/$asset.sha256"
(cd "$staging" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$asset.sha256"; else shasum -a 256 -c "$asset.sha256"; fi)
checksum=$(cut -d ' ' -f 1 "$staging/$asset.sha256")
mkdir "$staging/bundle"
tar -xzf "$staging/$asset" -C "$staging/bundle"
FLOW_CLOUD_CLI_HOME="$install_home" "$staging/bundle/runtime/bin/node" "$staging/bundle/scripts/flow-cloud-cli.mjs" install-bundle "$staging/bundle" "$checksum"

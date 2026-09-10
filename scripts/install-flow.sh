#!/bin/sh
set -eu
# Installs the browser launcher from this checkout; no Flow npm package is used.
FLOW_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FLOW_PREFIX=${HOME}/.local
FLOW_BUILD=1
FLOW_BUILD_ONLY=0
FLOW_BOOTSTRAP=''
FLOW_TEMP=''
trap '[ -z "$FLOW_TEMP" ] || rm -f "$FLOW_TEMP"; [ -z "$FLOW_BOOTSTRAP" ] || rm -rf "$FLOW_BOOTSTRAP"' EXIT
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || { echo '--prefix requires a directory' >&2; exit 1; }; FLOW_PREFIX=$2; shift 2 ;;
    --no-build) FLOW_BUILD=0; shift ;;
    --build-only) FLOW_BUILD_ONLY=1; shift ;;
    *) echo "Usage: $0 [--prefix DIRECTORY] [--no-build|--build-only]" >&2; exit 1 ;;
  esac
done
FLOW_NODE=$(command -v node || true)
[ -n "$FLOW_NODE" ] || { echo 'Install Node.js 24.13.1+ (24.x) first.' >&2; exit 1; }
"$FLOW_NODE" -e 'const [m,n,p]=process.versions.node.split(".").map(Number); if (m!==24 || n<13 || (n===13 && p<1)) { console.error("Use Node.js 24.13.1+ (24.x)."); process.exit(1); }'
if [ "$FLOW_BUILD" = 1 ]; then
  cd "$FLOW_SOURCE"
  # This installer ships only the local browser app. The shared web package
  # imports Electron's auth adapter, but does not need an Electron executable.
  export FLOW_INSTALL_CPU=current FLOW_INSTALL_OS=current FLOW_INSTALL_LIBC=current
  export ELECTRON_SKIP_BINARY_DOWNLOAD=1
  if [ ! -x node_modules/.bin/vp ]; then
    # Bootstrap outside the workspace and skip Vite+'s browser-test peers. The
    # actual app dependencies are resolved by pnpm from the frozen lockfile.
    FLOW_BOOTSTRAP=$(mktemp -d)
    # Make the host binding required: npm can silently omit failed optional
    # downloads and otherwise report success with an unusable bootstrap.
    FLOW_VP_NATIVE=$("$FLOW_NODE" -p '"@voidzero-dev/vite-plus-" + process.platform + "-" + process.arch + (process.platform === "linux" ? (process.report.getReport().header.glibcVersionRuntime ? "-gnu" : "-musl") : "")')
    npm install --prefix "$FLOW_BOOTSTRAP" --legacy-peer-deps --no-audit --no-fund --package-lock=false vite-plus@0.3.0 "${FLOW_VP_NATIVE}@0.3.0"
    FLOW_VP="$FLOW_BOOTSTRAP/node_modules/.bin/vp"
  else
    FLOW_VP="$FLOW_SOURCE/node_modules/.bin/vp"
  fi
  # Brain workers import these shared services by source path, so they must be
  # included explicitly in addition to the server's workspace dependency tree.
  "$FLOW_VP" install --frozen-lockfile \
    --filter @t3tools/monorepo --filter 't3...' \
    --filter '@flow/brain-graph-gateway...' --filter '@flow/brain-orchestrator...'
  "$FLOW_NODE" --input-type=module - <<'JS'
import { prepareBrowserNative } from './scripts/prepare-browser-native.mjs';
prepareBrowserNative(process.cwd());
JS
  node_modules/.bin/vp run --filter @t3tools/web build
fi
[ -f "$FLOW_SOURCE/apps/web/dist/index.html" ] || { echo 'Build the web app before installing the launcher.' >&2; exit 1; }
[ "$FLOW_BUILD_ONLY" = 0 ] || exit 0
mkdir -p "$FLOW_PREFIX/bin"
FLOW_TARGET="$FLOW_PREFIX/bin/flow"
if [ -e "$FLOW_TARGET" ] && ! grep -q '^# flow-managed-launcher$' "$FLOW_TARGET"; then
  echo "Refusing to overwrite an existing command: $FLOW_TARGET. Choose another --prefix." >&2
  exit 1
fi
# The launcher is installed separately from ~/.flow/bin/flow, preserving existing memory hooks.
FLOW_TEMP=$(mktemp "$FLOW_PREFIX/bin/.flow-install.XXXXXX")
"$FLOW_NODE" --input-type=module - "$FLOW_NODE" "$FLOW_SOURCE/scripts/flow.mjs" "$FLOW_TEMP" <<'JS'
import { writeFileSync } from 'node:fs';
const [node, entry, target] = process.argv.slice(2);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
writeFileSync(target, '#!/bin/sh\n# flow-managed-launcher\nexec ' + quote(node) + ' ' + quote(entry) + ' "$@"\n', {mode:0o755});
JS
chmod 755 "$FLOW_TEMP"
mv "$FLOW_TEMP" "$FLOW_TARGET"
echo "Installed $FLOW_TARGET"
echo "Add $FLOW_PREFIX/bin to PATH if needed, then run flow."
echo 'Existing running instances and application data were left unchanged.'

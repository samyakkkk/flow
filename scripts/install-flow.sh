#!/bin/sh
set -eu
# Installs the browser launcher from this checkout; no Flow npm package is used.
FLOW_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FLOW_PREFIX=${HOME}/.local
FLOW_BUILD=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || { echo '--prefix requires a directory' >&2; exit 1; }; FLOW_PREFIX=$2; shift 2 ;;
    --no-build) FLOW_BUILD=0; shift ;;
    *) echo "Usage: $0 [--prefix DIRECTORY] [--no-build]" >&2; exit 1 ;;
  esac
done
FLOW_NODE=$(command -v node || true)
[ -n "$FLOW_NODE" ] || { echo 'Install Node.js 22.16+ or 24.10+ first.' >&2; exit 1; }
"$FLOW_NODE" -e 'const [m,n]=process.versions.node.split(".").map(Number); if (!((m===22&&n>=16)||(m>=24&&!(m===24&&n<10)))) { console.error("Use Node.js 22.16+ or 24.10+."); process.exit(1); }'
if [ "$FLOW_BUILD" = 1 ]; then
  cd "$FLOW_SOURCE"
  if [ ! -x node_modules/.bin/vp ]; then
    npm exec --yes --package=vite-plus@0.3.0 -- vp install --frozen-lockfile
  fi
  node_modules/.bin/vp run --filter @t3tools/web build
fi
[ -f "$FLOW_SOURCE/apps/web/dist/index.html" ] || { echo 'Build the web app before installing the launcher.' >&2; exit 1; }
mkdir -p "$FLOW_PREFIX/bin"
FLOW_TARGET="$FLOW_PREFIX/bin/flow"
if [ -e "$FLOW_TARGET" ] && ! grep -q '^# flow-managed-launcher$' "$FLOW_TARGET"; then
  echo "Refusing to overwrite an existing command: $FLOW_TARGET. Choose another --prefix." >&2
  exit 1
fi
# The launcher is installed separately from ~/.flow/bin/flow, preserving existing memory hooks.
FLOW_TEMP=$(mktemp "$FLOW_PREFIX/bin/.flow-install.XXXXXX")
trap 'rm -f "$FLOW_TEMP"' EXIT HUP INT TERM
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

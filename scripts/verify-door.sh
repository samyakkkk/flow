#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-door.sh — ground-truth check for the cross-origin EXECUTION DOOR
# (dashboard/src/proxy.ts). Turns "does the local Flow answer the browser's
# run-agents-here probe?" into ONE command instead of an internals rabbit hole.
#
# It boots a THROWAWAY local-mode dashboard off the current build and curls the
# exact preflight the browser makes from a connected deployment's origin:
#   - OPTIONS must return the CORS + Private-Network-Access headers
#   - a known Origin (a remote in ~/.flow/config.json) is allowed
#   - an unknown Origin gets NO cors headers (door stays shut)
#
# The door only opens in LOCAL mode by design (IS_LOCAL = FLOW_MODE != prod), so
# this runs the dashboard in local mode regardless of how your instances run.
#
#   scripts/verify-door.sh                 # verify against the first remote's origin
#   scripts/verify-door.sh --build         # clean-rebuild the dashboard first
#   ORIGIN=https://x.nip.io scripts/verify-door.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$HERE/dashboard"
NEXTBIN="$HERE/node_modules/.bin/next"
PORT="${DOOR_TEST_PORT:-8791}"
CFG="$HOME/.flow/config.json"

# Origin to test: explicit $ORIGIN, else the first remote's URL origin.
ORIGIN="${ORIGIN:-$(python3 - "$CFG" <<'PY' 2>/dev/null || true
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    for r in d.get("remotes",{}).values():
        u=r.get("url") or ""
        if u.startswith("http"):
            from urllib.parse import urlsplit; s=urlsplit(u)
            print(f"{s.scheme}://{s.netloc}"); break
except Exception: pass
PY
)}"
[ -n "${ORIGIN:-}" ] || { echo "✗ no origin — set ORIGIN=... or connect a remote (flow connect)"; exit 1; }

if [ "${1:-}" = "--build" ]; then
  echo "▸ clean rebuild (NODE_ENV unset so devDeps aren't pruned)…"
  rm -rf "$DASH/.next"
  ( cd "$DASH" && NODE_ENV= "$NEXTBIN" build >/tmp/verify-door-build.log 2>&1 ) \
    || { echo "✗ build failed — see /tmp/verify-door-build.log"; tail -20 /tmp/verify-door-build.log; exit 1; }
fi

echo "▸ booting throwaway local-mode dashboard on :$PORT …"
( cd "$DASH" && FLOW_MODE= NODE_ENV=production PORT="$PORT" "$NEXTBIN" start --port "$PORT" >/tmp/verify-door.log 2>&1 ) &
DASH_PID=$!
cleanup() { kill "$DASH_PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:$PORT/login" 2>/dev/null || echo 000)" = "200" ] && break
  sleep 1
  [ "$i" = "30" ] && { echo "✗ dashboard never came up"; tail -20 /tmp/verify-door.log; exit 1; }
done

echo "▸ OPTIONS preflight from $ORIGIN"
PRE=$(curl -s -D - -o /dev/null --max-time 5 -X OPTIONS \
  -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: x-flow-pairing" \
  -H "Access-Control-Request-Private-Network: true" \
  "http://localhost:$PORT/api/auth/status" 2>/dev/null)

fail=0
grep -qi "access-control-allow-origin: $ORIGIN" <<<"$PRE" || { echo "  ✗ missing allow-origin"; fail=1; }
grep -qi "access-control-allow-private-network: true" <<<"$PRE" || { echo "  ✗ missing allow-private-network"; fail=1; }
[ "$fail" = 0 ] && echo "  ✓ CORS + private-network headers present"

echo "▸ negative: unknown origin must get NO cors"
NEG=$(curl -s -D - -o /dev/null --max-time 5 -X OPTIONS -H "Origin: https://evil.example" \
  -H "Access-Control-Request-Method: GET" "http://localhost:$PORT/api/auth/status" 2>/dev/null)
if grep -qi "access-control-allow-origin" <<<"$NEG"; then echo "  ✗ leaked cors to unknown origin"; fail=1; else echo "  ✓ unknown origin denied"; fi

[ "$fail" = 0 ] && { echo "✔ DOOR OK — a local-mode Flow off this build answers the browser probe"; exit 0; }
echo "✗ DOOR NOT WORKING — the local Flow won't be reachable by a connected deployment's page"; exit 1

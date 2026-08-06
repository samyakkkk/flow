#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-command redeploy of the current worktree to a Hetzner (or any Docker) box.
# Rsyncs the source (never node_modules/.next/.git/data), rebuilds ONLY the flow
# container, waits for it to serve, and runs the persona suite as a smoke test.
# The FalkorDB volume persists (D1) — the brain is NOT wiped.
#
#   FLOW_DEPLOY_IP=1.2.3.4 FLOW_DEPLOY_KEY=~/.config/hetzner-flow-test-key \
#   FLOW_DEPLOY_DOMAIN=1-2-3-4.nip.io  scripts/deploy-hetzner.sh
#
# Defaults target the current test box.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

IP="${FLOW_DEPLOY_IP:-167.233.240.21}"
KEY="${FLOW_DEPLOY_KEY:-$HOME/.config/hetzner-flow-test-key}"
DOMAIN="${FLOW_DEPLOY_DOMAIN:-167-233-240-21.nip.io}"
REMOTE_DIR="${FLOW_DEPLOY_DIR:-/root/flow}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "▸ Deploying $HERE → root@$IP:$REMOTE_DIR"
[ -f "$KEY" ] || { echo "✗ ssh key not found: $KEY"; exit 1; }

echo "▸ rsync source (excluding node_modules/.next/.git/data)…"
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude data --exclude '*.log' \
  -e "ssh -i $KEY -o StrictHostKeyChecking=no" "$HERE/" "root@$IP:$REMOTE_DIR/"

echo "▸ rebuild + restart the flow container (FalkorDB volume kept)…"
ssh -i "$KEY" -o StrictHostKeyChecking=no "root@$IP" \
  "cd $REMOTE_DIR/deploy && docker compose up --build -d flow"

echo "▸ waiting for the dashboard to serve…"
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "https://$DOMAIN/login" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then echo "  up (200) after $((i*8))s"; break; fi
  sleep 8
  [ "$i" = "40" ] && { echo "✗ dashboard never came up"; exit 1; }
done

echo "▸ smoke test — persona suite:"
FLOW_TEST_DOMAIN="$DOMAIN" bash "$HERE/scripts/persona-tests.sh"

#!/usr/bin/env bash
# Container entrypoint: create the prod project on first boot, start Flow via
# the normal CLI, then hold the container open and forward SIGTERM to a clean
# `flow down`. FLOW_PROJECT names the (single) project this deployment hosts;
# additional projects can be created later with `docker exec <ctr> node
# bin/flow.mjs project create <name> --mode prod` + `... up <name>`.
set -euo pipefail
cd /app

FLOW="node bin/flow.mjs"
PROJECT="${FLOW_PROJECT:-main}"

if [ ! -f "data/projects/${PROJECT}/project.json" ]; then
  $FLOW project create "$PROJECT" --mode prod
fi

# `flow up` spawns services detached and exits — the setup code it prints on
# a fresh auth store is the one the first user needs, so keep it visible.
$FLOW up "$PROJECT"

stop() {
  echo "container stopping — flow down"
  $FLOW down || true
  exit 0
}
trap stop TERM INT

# Surface service logs in the foreground.
touch /tmp/keepalive
tail -f /tmp/keepalive data/logs/*.log data/projects/"$PROJECT"/logs/*.log 2>/dev/null &
TAIL_PID=$!

# Supervise. Services are spawned DETACHED with no supervisor, the healthcheck
# only probes the dashboard, and Docker's restart policy does NOT act on
# healthcheck status — so a crashed orchestrator/gateway would otherwise be a
# SILENT partial outage (dashboard still 200s). `flow up` is idempotent:
# portInUse skips live services and restarts only the dead ones, without
# rebuilding (BUILD_ID unchanged) or reprinting the setup code (stored
# setupToken; only shown pre-bootstrap). Re-run it on an interval as the
# supervisor. The loop keeps the container in the foreground; SIGTERM interrupts
# the sleep and runs `stop` for a clean `flow down`.
FLOW_SUPERVISE_INTERVAL="${FLOW_SUPERVISE_INTERVAL:-30}"
while kill -0 "$TAIL_PID" 2>/dev/null; do
  sleep "$FLOW_SUPERVISE_INTERVAL"
  $FLOW up "$PROJECT" >/dev/null 2>&1 || true
done

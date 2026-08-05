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

# Stay in the foreground, surfacing service logs when present.
touch /tmp/keepalive
tail -f /tmp/keepalive data/logs/*.log data/projects/"$PROJECT"/logs/*.log 2>/dev/null &
wait $!

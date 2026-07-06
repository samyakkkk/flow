#!/usr/bin/env bash
# flow/verify-all.sh — Host-mode verification suite (no Docker required).
#
# Runs every verification step in order:
#   1. graph-gateway  — TypeScript typecheck (npx tsc --noEmit)
#   2. orchestrator   — Unit + scenario tests (npm test)
#   3. simulators     — Full scenario verify: boots orchestrator + linear-mock
#                       internally, runs all scenarios (npm run verify)
#   4. dashboard      — Build + smoke test (npm run verify)
#   5. [optional]     — Real integrations (npm run verify:real), if FLOW_VERIFY_REAL=1
#
# Usage:
#   bash flow/verify-all.sh
#   FLOW_VERIFY_REAL=1 bash flow/verify-all.sh
#
# Each step prints a PASS or FAIL banner. The script exits nonzero if any
# step fails. All steps run regardless of earlier failures so you see the
# full picture in one pass.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="${SCRIPT_DIR}"  # unified repo: everything lives under flow/

GATEWAY_DIR="${WORKSPACE_DIR}/graph-gateway"
ORCHESTRATOR_DIR="${SCRIPT_DIR}/orchestrator"
SIMULATORS_DIR="${SCRIPT_DIR}/simulators"
DASHBOARD_DIR="${SCRIPT_DIR}/dashboard"

# ── Result tracking ──────────────────────────────────────────────────────────
OVERALL_START=$(date +%s)
STEP_COUNT=0
FAILED_COUNT=0

# Arrays: indexed by step number
NAMES=()
RESULTS=()
DURATIONS=()

# ── Helpers ──────────────────────────────────────────────────────────────────

banner() {
  echo ""
  echo "┌─────────────────────────────────────────────────────┐"
  printf  "│  %-52s│\n" "$1"
  echo "└─────────────────────────────────────────────────────┘"
}

run_step() {
  local name="$1"
  local dir="$2"
  shift 2
  local cmd=("$@")

  banner "STEP $((STEP_COUNT + 1)): ${name}"
  echo "  dir : ${dir}"
  echo "  cmd : ${cmd[*]}"
  echo ""

  local step_start
  step_start=$(date +%s)

  local exit_code=0
  (cd "${dir}" && "${cmd[@]}") || exit_code=$?

  local step_end
  step_end=$(date +%s)
  local dur=$(( step_end - step_start ))

  NAMES+=("${name}")
  DURATIONS+=("${dur}s")

  if [ "${exit_code}" -eq 0 ]; then
    RESULTS+=("PASS")
    echo ""
    echo "  ✓  PASS — ${name} (${dur}s)"
  else
    RESULTS+=("FAIL")
    FAILED_COUNT=$(( FAILED_COUNT + 1 ))
    echo ""
    echo "  ✗  FAIL — ${name} (exit ${exit_code}, ${dur}s)"
  fi

  STEP_COUNT=$(( STEP_COUNT + 1 ))
  echo ""
}

# ── Steps ────────────────────────────────────────────────────────────────────

run_step "graph-gateway typecheck" "${GATEWAY_DIR}" \
  node_modules/.bin/tsc --noEmit

run_step "orchestrator unit tests" "${ORCHESTRATOR_DIR}" \
  npm test

# Free port 17433 (simulator gateway stub) in case a prior run left a stale process
lsof -ti :17433 2>/dev/null | xargs -r kill -9 2>/dev/null; sleep 0.3

run_step "simulators scenario verify" "${SIMULATORS_DIR}" \
  npm run verify

run_step "dashboard build + smoke" "${DASHBOARD_DIR}" \
  npm run verify

if [ "${FLOW_VERIFY_REAL:-0}" = "1" ]; then
  run_step "orchestrator real integrations" "${ORCHESTRATOR_DIR}" \
    npm run verify:real
fi

# ── Summary table ────────────────────────────────────────────────────────────

OVERALL_END=$(date +%s)
TOTAL_TIME=$(( OVERALL_END - OVERALL_START ))

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  VERIFY-ALL SUMMARY                                          ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  %-38s  %-6s  %-8s║\n" "STEP" "RESULT" "DURATION"
printf "║  %-38s  %-6s  %-8s║\n" "--------------------------------------" "------" "--------"

for i in "${!NAMES[@]}"; do
  result="${RESULTS[$i]}"
  if [ "${result}" = "PASS" ]; then
    marker="✓"
  else
    marker="✗"
  fi
  printf "║  %-38s  %-6s  %-8s║\n" \
    "${NAMES[$i]}" \
    "${marker} ${result}" \
    "${DURATIONS[$i]}"
done

echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  %-54s║\n" "Total time: ${TOTAL_TIME}s"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if [ "${FAILED_COUNT}" -eq 0 ]; then
  echo "  ALL ${STEP_COUNT} STEPS PASSED"
  exit 0
else
  echo "  ${FAILED_COUNT}/${STEP_COUNT} STEPS FAILED — see output above for details"
  exit 1
fi

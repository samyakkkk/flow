#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Flow persona validation — API level, re-runnable, no browser required.
# Exercises the real deployment as each persona and asserts the outcomes that
# define "Flow works for them". See docs/personas.md for the human story.
#
#   scripts/persona-tests.sh
#
# Override via env: FLOW_TEST_DOMAIN, FLOW_TEST_PROJECT, FLOW_OWNER_EMAIL/PASS,
# FLOW_MEMBER_EMAIL/PASS. GitHub PAT read from ~/.config/flow-test-github-pat.env.
# Exit code = number of failed assertions (0 = all green).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DOMAIN="${FLOW_TEST_DOMAIN:-167-233-240-21.nip.io}"
BASE="https://$DOMAIN"
PROJECT="${FLOW_TEST_PROJECT:-main}"
OWNER_EMAIL="${FLOW_OWNER_EMAIL:-sam@acme.dev}"
OWNER_PASS="${FLOW_OWNER_PASS:-hetznertest1}"
MEMBER_EMAIL="${FLOW_MEMBER_EMAIL:-alex@acme.dev}"
MEMBER_PASS="${FLOW_MEMBER_PASS:-memberpass1}"
TEST_REPO_FULL="${FLOW_TEST_REPO:-olostep-api/olostep-cli}"
TEST_REPO_URL="https://github.com/${TEST_REPO_FULL}"
[ -f "$HOME/.config/flow-test-github-pat.env" ] && source "$HOME/.config/flow-test-github-pat.env"

OJ=$(mktemp); MJ=$(mktemp)
trap 'rm -f "$OJ" "$MJ"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }
code(){ curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$@"; }
jget(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

echo "══════════════════════════════════════════════════════════════════"
echo " Flow persona validation → $BASE  (project: $PROJECT)"
echo "══════════════════════════════════════════════════════════════════"

# ── P1 · Priya (owner) sets up the workspace ────────────────────────────────
echo
echo "P1 · OWNER SETUP (Priya)"
c=$(curl -s -c "$OJ" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/login" \
     -H 'Content-Type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASS\"}")
[ "$c" = "200" ] && ok "owner logs in ($c)" || bad "owner login failed ($c)"

role=$(curl -s -b "$OJ" "$BASE/api/auth/status" | jget "d.get('user',{}).get('role')")
[ "$role" = "owner" ] && ok "owner role = owner" || bad "owner role = $role (want owner)"

if [ -n "${GITHUB_PAT:-}" ]; then
  c=$(curl -s -b "$OJ" -o /dev/null -w "%{http_code}" -X POST "$BASE/$PROJECT/api/github/repos" \
       -H 'Content-Type: application/json' -d "{\"action\":\"save_pat\",\"pat\":\"$GITHUB_PAT\"}")
  [ "$c" = "200" ] && ok "owner saves GitHub PAT ($c)" || bad "save_pat failed ($c)"

  src=$(curl -s -b "$OJ" "$BASE/$PROJECT/api/github/repos" | jget "d.get('source')")
  n=$(curl -s -b "$OJ" "$BASE/$PROJECT/api/github/repos" | jget "len(d.get('repos',[]))")
  { [ "$src" = "pat" ] && [ "${n:-0}" -gt 0 ]; } && ok "owner lists $n repos via PAT" || bad "repo list src=$src n=$n"

  add=$(curl -s -b "$OJ" -X POST "$BASE/$PROJECT/api/github/repos" -H 'Content-Type: application/json' \
        -d "{\"action\":\"add_repos\",\"repos\":[{\"full_name\":\"$TEST_REPO_FULL\",\"url\":\"$TEST_REPO_URL\",\"default_branch\":\"main\",\"branch\":\"main\"}]}" \
        | jget "d.get('results',[{}])[0].get('ok')")
  [ "$add" = "True" ] && ok "owner connects repo $TEST_REPO_FULL" || bad "add_repos ok=$add"
else
  bad "GITHUB_PAT not found — skipping GitHub assertions"
fi

# repo reaches indexing/indexed (poll a few times — clone+embed takes a moment)
st=""
for _ in 1 2 3 4 5 6; do
  st=$(curl -s -b "$OJ" "$BASE/$PROJECT/api/repos/status" | jget "[r.get('status') for r in d.get('repos',[])]")
  echo "$st" | grep -qE "indexing|indexed" && break
  sleep 5
done
echo "$st" | grep -qE "indexing|indexed" && ok "repo is indexing/indexed: $st" || bad "repo never indexed: $st"

# ── P2 · Alex (member) — read-only, can link own tools, blocked from config ──
echo
echo "P2 · MEMBER (Alex)"
c=$(curl -s -c "$MJ" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/login" \
     -H 'Content-Type: application/json' -d "{\"email\":\"$MEMBER_EMAIL\",\"password\":\"$MEMBER_PASS\"}")
[ "$c" = "200" ] && ok "member logs in ($c)" || bad "member login failed ($c) — create $MEMBER_EMAIL first"

role=$(curl -s -b "$MJ" "$BASE/api/auth/status" | jget "d.get('user',{}).get('role')")
[ "$role" = "member" ] && ok "member role = member" || bad "member role = $role (want member)"

c=$(curl -s -b "$MJ" -o /dev/null -w "%{http_code}" -X POST "$BASE/$PROJECT/api/github/repos" \
     -H 'Content-Type: application/json' -d '{"action":"save_pat","pat":"x"}')
[ "$c" = "403" ] && ok "member BLOCKED from GitHub config (403)" || bad "member got $c on save_pat (want 403)"

c=$(curl -s -b "$MJ" -o /dev/null -w "%{http_code}" -X PUT "$BASE/$PROJECT/api/settings" \
     -H 'Content-Type: application/json' -d '{"LINEAR_API_KEY":"x"}')
[ "$c" = "403" ] && ok "member BLOCKED from settings (403)" || bad "member got $c on settings (want 403)"

c=$(code -b "$MJ" "$BASE/$PROJECT/api/repos/status")
[ "$c" = "200" ] && ok "member CAN read repo status ($c)" || bad "member read repo status = $c"

# member's OWN coding sessions feed the brain (capture via ingest hook + PAT) —
# the "link stuff and contribute" half of the member story.
MPAT=$(curl -s -b "$MJ" -X POST "$BASE/$PROJECT/api/tokens" -H 'Content-Type: application/json' \
       -d '{"label":"persona capture"}' | jget "d.get('token','')")
NONCE="p$$-$(date +%s 2>/dev/null || echo 0)"
cap=$(curl -s -X POST "$BASE/$PROJECT/v1/ingest/hook" -H "Authorization: Bearer $MPAT" -H 'Content-Type: application/json' \
      -d "{\"harness\":\"claude-code\",\"repo\":\"persona-cap\",\"event\":{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"cap-$NONCE\",\"prompt\":\"FLOW-CAP-$NONCE\"}}" \
      --max-time 20 | jget "d.get('ok')")
[ "$cap" = "True" ] && ok "member's own session feeds the brain (ingest hook 200)" || bad "member capture failed ($cap)"

# ── P3/P5 · remote brain over MCP + consumer connector ──────────────────────
echo
echo "P3/P5 · REMOTE BRAIN + CONNECTOR (Jordan / Maya)"
MCPHDR=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
# A personal token (what a ChatGPT/claude.ai connector or a local agent uses).
PAT=$(curl -s -b "$OJ" -X POST "$BASE/$PROJECT/api/tokens" -H 'Content-Type: application/json' \
      -d '{"label":"persona-test connector"}' | jget "d.get('token','')")
[ -n "$PAT" ] && ok "mint personal access token (connector credential)" || bad "token mint failed"

ntools=$(curl -s -X POST "$BASE/$PROJECT/mcp" -H "Authorization: Bearer $PAT" "${MCPHDR[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' --max-time 20 \
  | python3 -c "import sys,re,json;t=sys.stdin.read();m=re.search(r'\{.*\}',t,re.S);d=json.loads(m.group(0)) if m else {};print(len(d.get('result',{}).get('tools',[])))" 2>/dev/null)
{ [ -n "$ntools" ] && [ "$ntools" -ge 8 ]; } && ok "remote brain MCP serves $ntools tools (connector works)" || bad "MCP tools=$ntools (want ≥8)"

hasknow=$(curl -s -X POST "$BASE/$PROJECT/mcp" -H "Authorization: Bearer $PAT" "${MCPHDR[@]}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"orient","arguments":{}}}' --max-time 30 \
  | python3 -c "import sys,re,json;t=sys.stdin.read();m=re.search(r'\{.*\}',t,re.S);d=json.loads(m.group(0)) if m else {};c=d.get('result',{}).get('content',[]);print('yes' if c and c[0].get('text') else 'no')" 2>/dev/null)
[ "$hasknow" = "yes" ] && ok "orient() returns real brain knowledge" || bad "orient returned nothing ($hasknow)"

c=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/$PROJECT/mcp" "${MCPHDR[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' --max-time 15)
[ "$c" = "401" ] && ok "MCP rejects a request with NO token (401)" || bad "MCP no-token = $c (want 401)"

# ── P4 · durability — the connected repo is still registered (survives runs) ──
echo
echo "P4 · DURABILITY (Sam, returning)"
rn=$(curl -s -b "$OJ" "$BASE/$PROJECT/api/repos" | jget "len(d.get('repos',[]))")
{ [ -n "$rn" ] && [ "$rn" -gt 0 ]; } && ok "brain still has $rn indexed repo(s)" || bad "no repos registered ($rn)"

echo
echo "══════════════════════════════════════════════════════════════════"
echo " RESULT: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════════════════════════════"
exit $FAIL

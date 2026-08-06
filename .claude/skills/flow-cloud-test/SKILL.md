---
name: flow-cloud-test
description: Validate a self-hosted Flow deployment end-to-end as real user personas (owner setup, member access, GitHub indexing, remote-brain MCP, consumer connectors). Use when asked to test/verify/QA a Flow prod deployment, run persona tests, check owner-vs-member gating, or confirm "does Flow work for a team" after a deploy. Covers API-level assertions (robust) + agent-browser UI checks (evidence).
allowed-tools: Bash, Read, Skill
---

# Flow cloud/persona testing

Validate a self-hosted Flow deployment the way a real team would use it. Two
layers: **API-level** assertions (robust, deterministic — start here) and
**agent-browser** UI checks (visual evidence, flakier).

## Hard rules (never break)
- **NEVER `flow down` / `flow down flow`** on the machine hosting the driving
  session — it kills the session. Down only throwaway aliases (`ec2sim`, `t1`).
- Test **code changes** on an isolated CLI alias (`ec2sim` → `localhost:8600`,
  its own FalkorDB), never the user's main `:7600` flow. See `docs/testing.md`.
- Secrets are mode-600 in `~/.config/` — never echo them. GitHub PAT:
  `~/.config/flow-test-github-pat.env` (`source` it, use `$GITHUB_PAT`).

## Deployment facts (learned the hard way)
- A deployment is **single-project** by design: the entrypoint brings up only
  `FLOW_PROJECT` (default `main`). Test against **`main`**, not ad-hoc projects
  — a secondary project's orchestrator does NOT survive `docker compose up`.
- Real per-project ports in the container: gateway 7443, orchestrator 7510.
- Login is the **global** endpoint `POST /api/auth/login` (sets a cookie);
  project-scoped calls use the `/<project>/...` prefix.
- New users created via `POST /api/access/users {email,password,grants}` are
  **members**; the bootstrap user is the **owner**.
- `NODE_ENV=production` during `npm install` omits devDeps → dashboard build
  breaks. If you build locally: `NODE_ENV= npm ci --include=dev`.

## Fast path — run the harness
```bash
bash scripts/persona-tests.sh          # 12 API assertions, exit code = failures
# override: FLOW_TEST_DOMAIN, FLOW_TEST_PROJECT, FLOW_OWNER_EMAIL/PASS, FLOW_MEMBER_EMAIL/PASS
```
It covers P1 (owner: bootstrap→GitHub PAT→list→add repo→indexing), P2 (member:
read-only, 403 on config, can read), P4 (durability). See `docs/personas.md`.

## The personas (what "working" means)
- **P1 Owner setup** — save PAT (`POST /<p>/api/github/repos {action:save_pat}`),
  list (`GET`), add (`{action:add_repos}`), poll `GET /<p>/api/repos/status`
  until `indexing|indexed`. An indexed repo becomes a **node in the brain**.
- **P2 Member** — `role==member`; integration writes 403
  (`canManageIntegrations`); UI shows read-only "What feeds this project's
  brain" (0 Connect buttons); can still link own tools + mint a connector token.
- **P3 Agent-runner (remote brain)** — `POST /<p>/mcp` with a machine PAT
  (Bearer) speaks MCP: `initialize`, `tools/list` (8 tools), `tools/call orient`
  returns real knowledge; no token → 401. This is the remote-brain half of C2.
- **P4 Returning owner** — the indexed repo/brain survives redeploys (D1).
- **P5 Consumer connector** — mint a PAT (`POST /<p>/api/tokens {label}`, shown
  once), it works as an MCP connector against `/<p>/mcp`. No marketplace.

## MCP smoke (remote brain / connector)
```bash
TOK=<machine-or-personal-PAT>
curl -s -X POST "$BASE/main/mcp" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# expect result.tools = orient, find_entity, get_entity, read_query,
# list_schema, correct_graph, remember, search_knowledge
```

## agent-browser UI checks (evidence)
`Skill(agent-browser)` then `agent-browser skills get core`. Pattern:
1. `open $BASE/login` → `snapshot -i` → fill email/password → click Sign in.
2. `open $BASE/main`, `wait --load networkidle`, `snapshot -i`.
3. Owner sees "Connect code and business context" + Connect buttons;
   member sees "What feeds this project's brain" + **0** Connect buttons.
4. `screenshot /tmp/persona-*.png`.
Gotchas: refs go stale after any nav — re-snapshot. LNA (browser→localhost)
is **auto-denied** in automation, so the local-execution/dual-origin path
(browser reaching `localhost:8600`) can't be fully driven headlessly — verify
its API + door mechanics with curl instead. If a session wedges, `close --all`
and reopen; don't chain too many commands in one shot.

## Deploy a code change to the box, then re-test
```bash
IP=<ip>; KEY=~/.config/hetzner-flow-test-key
rsync -az --delete --exclude node_modules --exclude .next --exclude .git \
  --exclude data -e "ssh -i $KEY" ./ root@$IP:/root/flow/
ssh -i $KEY root@$IP 'cd /root/flow/deploy && docker compose up --build -d flow'
# poll $BASE/login for 200, then: bash scripts/persona-tests.sh
```
The FalkorDB volume persists across this (D1). Confirm a shipped UI string with
`docker exec deploy-flow-1 grep -rl "<string>" dashboard/.next`.

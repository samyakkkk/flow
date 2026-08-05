# Multi-Deployment Plan: EC2-hostable Flow + Dual-Origin Dashboard

_Plan doc, 2026-08-05. Companion to `harness-integrations.md` (§7 defines the target
architecture). Scope: the platform work — EC2 deployability, `flow connect`, user API tokens,
dual-origin dashboard, MCP exposure. Explicitly OUT of scope here: hooks/skills/capture
(separate worktree; see "Impact on the hooks tree" at the bottom)._

## Ground rules

- **Never touch the developer's main `flow` deployment.** No `flow up`/`flow down` on it, no
  port collisions, no shared data dirs. All testing uses the alias system from
  `docs/testing.md`: `setup.sh --alias <name> --branch <b> --port-offset <n> --fresh-db`
  gives an isolated checkout (`~/.flow/checkouts/<name>`), own launcher command, own data/,
  own FalkorDB container (`flow-falkordb-<alias>`). Offsets ≥1000 apart.
- Prod mode already exists end-to-end: `flow project create <name> --mode prod` makes the
  deployment prod (`bin/flow.mjs:307`), `flow up` prints a one-time setup code
  (`bin/flow.mjs:336-343,621-643`), dashboard auth activates via `FLOW_MODE=prod` →
  `IS_LOCAL=false` (`dashboard/src/lib/config.ts:22`). Auth store has owner bootstrap,
  email/password users, session cookies, per-user project grants
  (`dashboard/src/app/api/auth/*`, `api/access/users/*`, `lib/authStore`).
- The dashboard is already multi-project with server-side per-project admin tokens
  (`dashboard/src/lib/registry.ts`, `proxy.ts`) — tokens never reach the browser.
- `deploy/docker-compose.yml` is STALE (single-project, `GRAPH_NAME`/`ORCHESTRATOR_URL`
  envs) — do not build on it; replace in Phase 1b.

## Phase 1 — EC2 sim

### 1a. Alias-based sim (primary inner loop — fast, native)

```bash
./setup.sh --alias ec2sim --branch <this-branch> --port-offset 1000 --fresh-db
ec2sim project create acme --mode prod
ec2sim up acme          # prints one-time setup code; dashboard on :8600
```

Distinct browser origin: add `127.0.0.1 flow-ec2.test` to `/etc/hosts` and browse
`http://flow-ec2.test:8600`. The browser now sees the sim ("EC2") and `localhost:7600`
(the real local flow) as different origins — exercises auth, CORS, pairing, dual-origin
fetching. Note: PNA (Chrome Private Network Access) will NOT trigger here (both resolve
local); that's the Phase 3 tunnel spike's job.

Smoke-test existing prod surface first: bootstrap with setup code → owner login → member
w/ single-project grant → project routing → confirm grant enforcement.

### 1b. Docker parity (headless EC2 realism)

Container that runs the SAME CLI path (not a bespoke compose): image installs repo +
`flow` CLI, entrypoint runs `flow project create --mode prod` + `flow up`; FalkorDB
sidecar on the compose network (no host port); ONLY the dashboard port published
(e.g. 8600). Replaces the stale `deploy/docker-compose.yml`. Verifies headless behavior
(no work folders/CLIs on the box) and the upgrade story. Optional Caddy service for HTTPS.

## Phase 2 — user API tokens + `flow connect`

1. **User-scoped API tokens** in the auth store: minted per user, named per machine,
   revocable, project-grant-enforced on every use. Auth paths accept
   `Authorization: Bearer <token>` alongside the session cookie.
   These tokens are the credential for: CLI→deployment calls, browser pairing (Phase 3),
   MCP (Phase 4), and later the hooks tree's transcript ingest.
2. **`flow connect <url>`**: device-flow — CLI opens `<url>/connect?code=…`, user approves
   in the (logged-in) dashboard, deployment mints a machine token, CLI stores
   `{name, url, token}` under `remotes` in `~/.flow/config.json`. `flow remotes` lists;
   `flow remotes remove <name>` revokes locally (+ server-side revoke call).
3. **Dashboard Connect page** (prod mode): shows the connect command, the user's
   connected machines, token revocation. Lives per deployment (each dashboard is
   authoritative for its own projects — no aggregation at :7600).

## Phase 3 — dual-origin dashboard

1. **Tunnel spike FIRST (half-day, de-risks the architecture):** serve any page from a
   real HTTPS origin (cloudflared/ngrok) and verify fetches to `http://localhost:7600`
   in Chrome (PNA preflight: answer `Access-Control-Request-Private-Network` with
   `Access-Control-Allow-Private-Network: true`), Firefox, Safari. Safari is the open
   question. If it fails there → Safari users get the localhost-shell mode (page served
   from :7600 browsing remote projects — same SPA, easier browser direction, already
   designed as the escape hatch).
2. **Local-side door:** middleware on the local dashboard accepting cross-origin calls:
   origin allowlist derived from `~/.flow/config.json` remotes; mandatory machine-scoped
   pairing token (minted at `flow connect`, delivered to the page via the deployment
   session); CORS + PNA headers. This is a new narrow token-only auth path — local mode
   otherwise stays auth-free.
3. **API-client registry in the SPA:** `brainApi(project)` = same-origin (as today);
   `executionApi` = probe `localhost:7600` + pairing token. Components declare their
   source. No proxying anywhere — the browser is the integration point.
4. **Wire the agents surfaces:** agents page + dashboard agent card fetch via
   `executionApi` — native/live when local flow is up (create/prompt/stream/steer/approve
   all browser→localhost); graceful "Start Flow on your machine to run agents here"
   otherwise. Session-mirror data is NOT in this phase (comes with ingest, hooks tree).

## Phase 4 — project-scoped MCP through the public dashboard

Expose `https://<deployment>/<project>/mcp`: dashboard route validates Bearer user token +
project grant, proxies server-side to that project's gateway MCP injecting the per-project
admin token (same pattern as `proxy.ts` REST proxying). This is arrow ③ of the
architecture diagram, the URL harness MCP configs point at, and eventually what
claude.ai/ChatGPT connectors use.

## Test matrix (on the sim)

| Scenario | Verifies |
|---|---|
| Fresh sim → bootstrap w/ setup code → member with one grant | existing prod auth, multi-project |
| `flow connect http://flow-ec2.test:8600` from the laptop | Phase 2 device flow + remotes file |
| Open `flow-ec2.test:8600/<project>/agents`, local flow up | dual-origin: page from "EC2", agent card native via localhost:7600 |
| Same, local flow down | graceful absence UX |
| Member without grant hits project APIs + MCP route | grant enforcement |
| `claude mcp add --transport http flow http://flow-ec2.test:8600/<p>/mcp` + token | Phase 4 from a real harness |
| Tunnel page → localhost:7600 in Chrome/Firefox/Safari | PNA/browser feasibility (Phase 3 spike) |

Ordering rationale: sim first (everything needs a second deployment to talk to); tokens
before dual-origin (pairing rides on them); tunnel spike before SPA work (only item that
could force an architecture change, and its fallback is designed). Phases 2–4 are each
independently landable PRs.

## Impact on the hooks/skills tree (harness-integrations.md)

The hooks plan's CONTENT is unchanged — atoms, materializer, per-tool renderings, courier
capture all stand. But three contracts are produced HERE and consumed THERE; agree on them
so the trees don't diverge:

1. **Token model (Phase 2)** — the hooks tree must NOT invent its own auth: the shim's
   ingest POSTs and the materializer's baked tokens are these user API tokens
   (`Authorization: Bearer`).
2. **URL shapes (Phase 4)** — the materializer bakes `https://<deployment>/<project>/mcp`
   (MCP) and `…/<project>/api/ingest/…` (transcripts; endpoint itself is built in the
   hooks tree but must live behind the same dashboard public routing + token check).
3. **Remotes file (Phase 2)** — `flow setup`'s deployment discovery reads the `remotes`
   in `~/.flow/config.json` that `flow connect` writes. Dependency: hooks-tree `flow
   setup` work should land after (or stub) Phase 2.

Sequencing consequence only: hooks tree can start immediately on the shim, dialect
normalizers, slim adapters, and skill/instruction content (no dependency), and should
stub the ingest URL + token until Phases 2/4 land.

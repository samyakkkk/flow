# Overnight Autonomous Run — Prod Dashboard + Persona Validation (2026-08-07)

**Owner:** Samyak · **Agent:** Opus 4.8 (this session) · **Duration:** ~12h
**Goal:** Wake up to *working shit* — a Flow prod deployment an admin can set up
from scratch, wire GitHub repos into (via the provided PAT), and that a normal
member can log into and actually use. Proven by real persona test agents driving
a real browser.

This file is the source of truth. I **keep it updated** — check items off, append
to the Progress Log, add tasks as I find them. The 30-min cron watchdog reads
this file to resume if my session dies.

---

## ⛔ HARD CONSTRAINTS (never violate)

1. **NEVER** `flow down` / `flow down flow` — the **`flow` project on :7600 is
   what THIS agent session runs on**. Killing it kills me. I may `down` *other*
   deployments (ec2sim, locsim, flow-test1) freely.
2. Never rebuild/restart/redeploy the user's **:7600 main flow**. All code
   testing runs on **`ec2sim` (:8600)** — worktree code, own db.
3. ec2sim has its OWN FalkorDB (`flow-falkordb-ec2sim`); safe to cycle. Never
   bounce the shared `flow-falkordb` / main gateway.
4. Secrets are mode-600, **never echoed**: GitHub PAT
   `~/.config/flow-test-github-pat.env`, Hetzner `~/.config/hetzner-flow-test.env`
   (+ ssh key `~/.config/hetzner-flow-test-key`), OpenRouter `/tmp/priya-test.env`.
5. Confirm before anything hard-to-reverse & outward-facing beyond the sandbox
   (deleting the Hetzner server; force-pushing). Redeploying the app is fine.
6. Guard installs: `NODE_ENV= npm ci --include=dev` (production omits devDeps →
   dashboard build breaks). Never run installs with NODE_ENV=production.

## 🗺️ Environment map

| Thing | Where | Notes |
|---|---|---|
| Main flow (MY LIFELINE) | `localhost:7600` | project `flow`. **NEVER touch.** |
| Local test rig | `ec2sim` → `localhost:8600` | worktree code, offset 1000, db `flow-falkordb-ec2sim`. Rebuild/restart freely. |
| Prod deployment | `https://167-233-240-21.nip.io` | Hetzner, docker compose, prod mode. Persona target. |
| Worktree (code) | `.../worktrees/flow/we-re-listening-to-bu85` | branch `flow/we-re-listening-to-bu85` |
| Hetzner box | IP `167.233.240.21` | ssh `~/.config/hetzner-flow-test-key`; code at `/root/flow` |
| GitHub PAT | `~/.config/flow-test-github-pat.env` | user `samyakkkk`; olostep/olostep-api repos |

**Deploy to Hetzner:** rsync worktree → `/root/flow` (exclude
node_modules/.next/.git/data), then
`ssh -i <key> root@167.233.240.21 'cd /root/flow/deploy && docker compose up --build -d flow'`.
FalkorDB volume persists (D1). In-container build installs devDeps cleanly.

## 🧠 Gotchas already learned (don't re-discover)
- `NODE_ENV=production` shell → npm omits devDeps → build fails w/ misleading
  `@tailwindcss/postcss` / workStore errors. Fix: `NODE_ENV= npm ci --include=dev`.
- Chrome LNA: public-origin→localhost needs a per-origin permission grant; the
  agent browser auto-denies it. Door mechanics testable via curl/relaxed flags.
- ec2sim runs natively on macOS → CLI *detection* there is false; test detection
  on Hetzner (real headless prod), not ec2sim.
- Prod owner-gating: `canManageIntegrations()` (local=allowed, prod=owner-only).

---

## ✅ Task checklist  (keep updated)

### Phase 0 — Foundation
- [x] Secure GitHub PAT (mode 600) + verify auth & repo list (user samyakkkk)
- [x] Pick isolated local test rig (ec2sim :8600, worktree code, own db)
- [x] Write this plan
- [x] Bring up ec2sim, verify it builds+serves (:8600 → 200, main :7600 still 200)
- [x] 30-min cron watchdog (session-only — resumes on idle; can't resurrect a fully dead process)
- [ ] Cloud/persona **testing skill** (deferred to Phase 4 — author from real experience)

### Phase 1 — D3: role-based integrations + admin GitHub config + repo browse (CENTRAL — personas need it)
- [x] API already works: owner-gated PAT storage + `/api/github/repos` browse + add_repos→index (RepoPicker.tsx / api/github/repos/route.ts)
- [x] VALIDATED on Hetzner `main` as owner: save_pat 200 · list 89 repos via PAT · add olostep-cli → status "indexing" (running job)
- [x] UI: added `useViewer` hook; IntegrationCatalog + Connections page gate to read-only for prod members (commit 1d7280f)
- [x] Deployed to Hetzner + VERIFIED via real browser: owner sees full editor (Connect btns, "1 REPOS ✓"); member `alex@acme.dev` sees "What feeds this project's brain" read-only, 0 Connect buttons, still gets own-tools panel. Member 403'd server-side. Screenshots: /tmp/persona-owner-integrations.png, /tmp/persona-member-*.png
- [x] BONUS: indexed repo (olostep-cli) shows as a node in the brain graph — full pipeline works end to end
**D3 DONE ✓**

**KEY DEPLOYMENT FACTS (learned):**
- Deployment is **single-project** by design (entrypoint brings up only
  `FLOW_PROJECT=main`). Use **`main`** for personas. The `acme` project is a
  dead manual experiment — its orchestrator (:7500) doesn't survive restart.
- Real per-project ports on the box: gateway 7443, orchestrator 7510, dash 7600.
- Owner `sam@acme.dev` / `hetznertest1` is a GLOBAL owner; can access `main`.
- ⚠️ Bug for later: redeploy leaves any *secondary* project's services down
  (only FLOW_PROJECT restarts). Fine for single-project prod; note for multi.

### Phase 2 — D4: consumer connectors without a marketplace
- [x] Insight: /<project>/mcp is already a bearer-authed remote MCP → connectors = URL + token, no marketplace
- [x] ConsumerConnectorModal (URL + mint PAT + per-app steps) + CodingToolsPanel cards become real Connect buttons in prod (commit a5c0a7e)
- [x] VERIFIED: member mints PAT via /api/tokens → PAT works against /main/mcp (all 8 brain tools). Cards render for member on Hetzner. Modal+cards live in deployed build.
**D4 DONE ✓** (member-allowed personal connector; instance-parameterized by origin+project)

### Phase 3 — C2: local execution + remote brain
- [x] Thread `BrainBinding` through orchestrator createSession + both mount sites (commit 4e2ecd5) — typechecks
- [x] POST /v1/agents/sessions accepts {brain:{mcpUrl,token}}
- [x] **Remote brain PROVEN**: POST Hetzner /main/mcp + machine PAT → 8 brain tools; orient() returns real indexed-repo knowledge; no token → 401
- [ ] Dashboard dual-origin composer sends the binding (LNA-gated e2e — needs real user browser grant; building blocks in place)
**C2 core done ✓ (remote brain proven, orchestrator ready); full browser e2e is LNA-gated**

### Phase 4 — Persona validation (headline deliverable)
- [ ] Fresh prod project on Hetzner (reset or new project) + owner account
- [ ] 3–5 personas defined (who / when / what / why) — see bottom section
- [ ] Test agents drive real browser (agent-browser): admin sets up project +
      GitHub repos; member logs in, accesses, links a workspace
- [ ] Pass/fail per persona; fix breakages; loop until green
- [ ] Persona report doc with evidence (screenshots)

### Phase 5 — Hardening (done)
- [x] `flow remotes` junk `local … undefined … since ?` row — fixed (commit b3ca314)
- [x] One-command Hetzner redeploy + smoke script (scripts/deploy-hetzner.sh, e82edb9) — verified rebuild→17/17
- [x] Code review of session diff (subagent) — 3 low/med findings; fixed the member-control flash (80f4b17)
- [x] Member capture path (ingest hook + PAT) verified + automated (17/17)
- [x] docs/HANDOFF.md — morning deploy-ready summary

### C2 — precise remaining scope (investigated, deliberately not built blind)
DONE + proven: orchestrator accepts `{brain:{mcpUrl,token}}` on POST
/v1/agents/sessions and mounts it as the flow-graph MCP (runtime.ts); the remote
brain answers over HTTP+PAT (8 tools, orient returns real knowledge, 401 w/o token).
Remaining (all NEW plumbing, can't be fully validated headlessly):
1. **Resolve-from-folder**: `work_folders` (orchestrator/src/agents/work-folders.ts)
   has NO remote/brain field, and `flow setup --remote` bakes the binding into
   hook commands + the flow-mcp bridge (bin/lib/materialize.mjs), not a store
   createSession reads. Need: a remote-binding column on work_folders + record it
   in setup + resolve it in createSession (→ pass brain). Testable on ec2sim.
2. **Dashboard dual-origin composer**: browser (served by deployment) → localhost
   execution door with the brain binding. **LNA-gated** — the agent browser
   auto-denies Local Network Access, so this can't be validated headlessly.
3. Resume-after-restart drops the in-memory brain binding (falls back to local);
   persist mcpUrl if remote-brain machines lack a local gateway.
Left as a clean, well-specified follow-up — building new feature plumbing that
can't be e2e-verified tonight would risk "working" for "more".

---

## 🔭 Watch / next ticks (for the cron watchdog to pick up)
- [x] 2nd repo indexed → **brain grew to 48 nodes** (MCP read_query, cypher arg). Both repos `indexed`.
- [x] BUG FOUND + FIXED: github-poller had a hardcoded demo seed (acme/api-service,
      acme/web-app) → recurring 404s on every deployment. Removed (commit 6074922);
      deployed; verified **0 phantom errors** after a full poll cycle. Tests 20/20.
- [x] **CRASH BUG FOUND + FIXED + FAULT-TESTED**: gateway's FalkorDB client had NO
      'error' listener → an unexpected socket close (server restart/blip) emitted
      an unhandled 'error' event → Node rethrows → **gateway crash**. Attached
      listeners (commit 0c78895). Fault-injected a FalkorDB restart: flow container
      stayed healthy, gateway logged "[falkordb] client error (auto-reconnecting)"
      + reconnected, brain queryable (48 nodes). Same class as the users-service
      Redis silent wedge. This is a real reliability win for every deployment.
- [ ] If agent-browser recovers, capture the owner GitHub-modal + D4 connector-modal
      screenshots (visual evidence; API already green 18/18).
- [ ] C2 dashboard dual-origin composer (only if the user wants it built blind —
      it's LNA-gated, can't be validated headlessly; orchestrator + remote brain ready).
- [ ] Consider persisting `brain.mcpUrl` for session resume (review finding #1).

## 🛡️ Reliability hardening (this session)
- Fixed 3 crash vectors + 2 defense-in-depth nets, all deployed + tests 282/282:
  1. github-poller hardcoded demo seed → recurring 404s (6074922)
  2. gateway FalkorDB client had no 'error' listener → crash on socket close; **fault-tested** (0c78895)
  3. ACP agent spawn had no 'error' listener → crash on ENOENT/EACCES (5cb3961)
  4. global unhandledRejection/uncaughtException nets on orchestrator + gateway (fe3d5c3)
  5. **AUTO-RECOVERY supervisor** in the container entrypoint (56d7122) — re-runs
     idempotent `flow up` every 30s; portInUse restarts only dead services, no
     rebuild, no setup-code spam. **FAULT-TESTED:** killed the orchestrator →
     endpoint 502 → supervisor restarted it within 30s → back to 200. The
     silent-partial-outage gap is CLOSED and self-healing. (Chosen over a
     healthcheck tweak, which Docker's restart policy ignores.)

## 🔐 Security posture (adversarial review 2026-08-07)
A subagent security review of this session's auth/token/gating/brain code found:
- **Finding 1 (CRITICAL) — FIXED + verified + regression-guarded (275dcfc).** A
  member PAT could hit `/<project>/v1/settings` `/v1/sources` `/v1/agents`
  `/v1/work-folders` directly — the proxy checked only any-grant and route.ts
  injects the ADMIN token into the role-blind orchestrator, bypassing D3's
  canManageIntegrations() gate. VERIFIED exploit: member `PUT /v1/settings` →
  200, wrote LINEAR_API_KEY. Fix: proxy now allows members only the agent/capture
  surface (verbs/embed/journal/reconcile/memory/ingest/corrections); every other
  /v1 segment requires owner (403). Verified: member settings/sources/agents →
  403, ingest+mcp → 200, owner → 200. Suite guards it (20/20).
- **Finding 2 (HIGH) — documented, not yet fixed.** `/v1/ingest/hook` derives the
  session row id `ext-<harness>-<externalId>` from client input with NO per-user
  attribution → an insider member can forge sessions or append to another user's
  session → memory-poisoning of the shared brain. Fix: proxy stamps a trusted
  `x-flow-pat-user` header (overwriting any client value), route.ts forwards it,
  orchestrator ingest namespaces the row id by user + rejects cross-user appends.
  Multi-file plumbing touching capture dedupe — deferred to avoid destabilizing
  the (green) capture flow blind. Insider-only, data-integrity (not secret theft).
- **Finding 3 (HIGH→reduced).** brain-binding SSRF via `/v1/agents` is now
  owner-only (member 403), so not member-exploitable. Residual: `mcpUrl` accepts
  `http://` + any host (no private-IP/metadata block) — tighten to https+allowlist
  for owner/local. Low urgency (owner-trusted).
- **Finding 4 (LOW).** PAT hashing/constant-time/project-scoping all correct;
  nits: no per-token expiry/revoke UI, 32-bit token id. Defense-in-depth only.
- **Finding 5 (SAFE).** The `/mcp` consumer-connector path is correctly
  read-scoped + project-gated (forwards the PAT, not admin; gateway re-verifies).

## 📓 Progress Log (newest first)
- 2026-08-07 T+N — Broadened validation: **gateway tests 24/24** (regression on my
  graph.ts/server.ts changes; orchestrator was 282/282 → all my code covered).
  **Hard container-restart durability test:** `docker restart deploy-flow-1` →
  brain nodes 49→49 (survived), dashboard back in 16s, **18/18 personas**, 1
  listener/port (supervisor + lsof fix hold across a full restart). The complete
  durability + recovery story is validated end-to-end.
- 2026-08-07 T+N — **Caught + fixed a regression my own supervisor introduced.**
  node:22 ships no `lsof`; `bin/flow.mjs portInUse` spawnSync'd lsof and (since
  spawnSync returns `{error}` not a throw on ENOENT) read every port as FREE →
  the supervisor's periodic `flow up` spawned DUPLICATE gateway/orchestrator →
  EADDRINUSE every 30s (absorbed by the new global net, so no crash, just spam).
  Found via the routine log health-scan. Fix (52acc29): Dockerfile installs
  lsof+procps AND portInUse falls back to a node-native TCP probe when lsof is
  absent (both paths unit-tested). Verified on the box: 1 listener/port, EADDRINUSE
  count stable across a supervisor cycle, `flow up` → "already running", 18/18.
  Lesson: the global net masked the symptom in logs — log-scanning is what caught it.
- 2026-08-07 T+N — **18/18 persona suite green** (owner setup, member gating+capture+can't-manage-users, remote brain, connector, durability). Multi-repo verified (2 repos registered). Deployed + smoke-tested via scripts/deploy-hetzner.sh. Code-reviewed (subagent) → fixed member-control flash. Skill + HANDOFF + deploy script shipped. 12 commits, branch clean. agent-browser went flaky mid-run (early owner/member screenshots captured). C2 composer left as documented LNA-gated follow-up.
- 2026-08-07 T0 — Plan created. PAT secured+verified. ec2sim = local rig. Earlier
  this session: fixed devDeps/NODE_ENV build break (no code change); committed
  home UI fixes (b8b1466); deployed+verified on Hetzner.

## 👥 Personas (define & script in Phase 4)
_TBD — 3–5: who uses Flow, when, doing what, why; each scripted as a browser-driving test agent._

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

### Phase 5 — If time remains (append freely)
- [ ] `flow remotes` junk `local  undefined  since ?` row — fix
- [ ] One-command Hetzner redeploy script
- [ ] `/code-review` + `/simplify` the diff
- [ ] Any persona-run bugs → fix + retest

---

## 📓 Progress Log (newest first)
- 2026-08-07 T0 — Plan created. PAT secured+verified. ec2sim = local rig. Earlier
  this session: fixed devDeps/NODE_ENV build break (no code change); committed
  home UI fixes (b8b1466); deployed+verified on Hetzner.

## 👥 Personas (define & script in Phase 4)
_TBD — 3–5: who uses Flow, when, doing what, why; each scripted as a browser-driving test agent._

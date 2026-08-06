# Morning Handoff — 2026-08-07 overnight run

Branch: `flow/we-re-listening-to-bu85`. Everything below is **committed** and,
where noted, **deployed + verified** on the live Hetzner box.

## TL;DR — it works
A self-hosted Flow deployment where an **owner** sets up the project + GitHub
repos (which index into the brain), a **member** logs in with read-only
integrations but can link their own tools + connect ChatGPT/claude.ai, and the
brain is reachable as a **remote MCP** — all validated on the real box.

**Live deployment:** https://167-233-240-21.nip.io (project `main`)
- Owner: `sam@acme.dev` / `hetznertest1`
- Member: `alex@acme.dev` / `memberpass1`
- Re-run all checks any time: `bash scripts/persona-tests.sh` → **12/12 green**

## What shipped tonight (commits, newest first)
- `b3ca314` fix(cli): `flow remotes` hides the junk `kind:local` row
- `e744e78` skill + persona docs (`.claude/skills/flow-cloud-test`, `docs/personas.md`)
- `a5c0a7e` **D4** consumer connectors (ChatGPT/claude.ai) — no marketplace
- `4e2ecd5` **C2** orchestrator mounts a REMOTE brain for a bound session
- `5de2ca5` persona validation suite (`scripts/persona-tests.sh`)
- `1d7280f` **D3** role-based integrations — members read-only, not 403s
- `b8b1466` honest local-exec detector message + prod connect layout (earlier)

## Verified deliverables
| Item | Evidence |
|---|---|
| **D3** owner/member integrations | browser: owner sees editor, member read-only (0 Connect btns). Screens `/tmp/persona-owner-*.png`, `/tmp/persona-member-*.png` |
| **GitHub → brain** | owner add repo → `status:"indexing"` → `olostep-cli` node in brain graph |
| **Member gating** | 403 on GitHub/settings writes; can read; can link own tools |
| **C2 remote brain** | `POST /main/mcp` + machine PAT → 8 brain tools; `orient()` real knowledge; no token → 401 |
| **D4 connectors** | member mints PAT → works as MCP connector (8 tools); cards+modal live |
| **D1 durability** | brain/repo survive `docker compose up --build` |

## To deploy for real (your own box)
1. `docs/hetzner-deploy.md` is the tested guide (nip.io + Caddy TLS, 4GB+swap, OpenRouter key).
2. Redeploy a code change to an existing box:
   ```bash
   IP=<ip>; KEY=<sshkey>
   rsync -az --delete --exclude node_modules --exclude .next --exclude .git \
     --exclude data -e "ssh -i $KEY" ./ root@$IP:/root/flow/
   ssh -i $KEY root@$IP 'cd /root/flow/deploy && docker compose up --build -d flow'
   ```
   FalkorDB volume persists (D1). Poll `/login` for 200, then `scripts/persona-tests.sh`.
3. Bootstrap the owner with the setup code printed by `docker compose logs -f flow`.

## Still open (honest)
- **C2 full P3 e2e** — a member running a Flow agent *on their laptop* with the
  *remote* brain. The remote-brain half is proven and the orchestrator accepts
  a brain binding; the missing piece is the dashboard dual-origin composer
  sending the binding + a **browser Local-Network-Access grant** (auto-denied in
  automation — needs a real human grant, can't be validated headlessly).
- **Global `flow` CLI** on this machine symlinks to the *parent* checkout, so it
  lacks `connect`/`remotes`/the fixes until this branch merges there (or
  `npm install -g .` from a checkout on this branch). Testing used the `ec2sim`
  alias (→ `:8600`) which runs the worktree directly.
- **Multi-project deployments**: a redeploy only restarts `FLOW_PROJECT`; a
  secondary project's services stay down. Fine for single-project prod.

## Guardrails honored
Never touched the user's `:7600` main flow. All code testing on `ec2sim`
(`:8600`, own DB). Secrets mode-600 in `~/.config`. 30-min cron watchdog
(`900be807`) resumes from `docs/overnight-prod-personas.md` if the session idles.

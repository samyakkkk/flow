# soul.md — how we build Flow

The always-reference. Read this before making changes, and update it when a
procedure or a hard-won lesson changes. It's the operating manual, not the
product docs (those are `README.md` / `docs/`).

---

## Golden rules (every change)

1. **Commit frequently, with a clear message**, so any change can be reverted.
   End commit messages with the `Co-Authored-By` trailer.
2. **Update `CHANGELOG.md` (and `ROADMAP.md` if scope changed) in the same
   commit — newest entry on top.** Write it for a human catching up.
3. **Verify by actually running it**, not just building. Use `flow doctor` for
   pages/assets and real screenshots for anything visual (see Verification).
4. **Never commit secrets or proprietary data.** `.env`, `data/`, `*.db`,
   `.next/`, `node_modules/`, `.context/` are gitignored — keep it that way.
   Before any public push, scan for real repo names / keys / local paths.
5. **Ask before destructive or outward-facing actions** (deleting data,
   pushing to a public remote, force-pushing). Review the diff first.

---

## Making a change → how to restart (READ THIS)

All project dashboards share **one** Next.js build (`dashboard/.next`). This is
the single biggest footgun:

> Rebuilding `.next` while a dashboard is running invalidates its chunk hashes,
> so it serves dead CSS/JS → the **unstyled page** bug (nav text, no styling,
> asset 404/500).

**So:**

- **Changed dashboard code?** Run `flow up` (no name). It rebuilds the shared
  `.next` when source changed **and refreshes every running dashboard** so none
  is left on the stale build. The dashboard is stateless, so refreshing it is
  free — `flow up` always restarts dashboards even for "already running"
  projects.
- **Changed orchestrator or gateway code?** Restart that project's services:
  `flow down <name> && flow up <name>`. (This drops agent sessions for that
  project — expected.)
- **NEVER hand-run `next start -p <port>` yourself.** It collides with the
  process `flow` manages and leaves zombies serving a stale build. Always go
  through `flow up`.
- After restarting, run **`flow doctor`** and expect all-green before you call
  it done.

Related gotchas baked into the CLI:
- "Already running" is detected by **port-in-use**, not a health probe (a flaky
  probe used to trigger a second orchestrator on the busy port → "didn't
  start"). See `portInUse()` in `bin/flow.mjs`.
- `flow down` / `flow up` take **one** project name or none (= all). Multi-name
  isn't supported yet.
- Deleting a project dir by hand leaves a zombie dashboard. Use **`flow rm
  <name>`** (stops first, then deletes).

---

## Verification (before saying "done")

1. **`flow doctor`** — for every project it checks services are up, every page
   is reachable, and the dashboard's CSS/JS assets actually load (catches the
   stale-build unstyled page). All-green or it's not done.
2. **Pixels for anything visual.** Drive `agent-browser`: `open` the URL, then
   `screenshot`, then `Read` the PNG. Local mode needs no login.
   - agent-browser flakes (SwiftShader, memory). If a screenshot times out or
     returns "Resource temporarily unavailable": `pkill -9 -f agent-browser;
     pkill -9 -f 'Chrome for Testing'`, wait, reopen. For the graph canvas,
     pause its animation first: `eval "document.querySelector('falkordb-canvas')?.setAnimation(false)"`.
     Kill orphaned MCP/adapter procs if memory is tight.
3. **Real end-to-end** for behavior changes — actually run the flow (start an
   agent, save a key, etc.), don't just check a status code.
4. **CLI changes (`bin/`) are verified by EXECUTING `flow up`**, never by
   `node --check` or tsc — the CLI is plain JS that tsc never sees, and
   parse-checking doesn't catch wrong call shapes. Scar tissue: `nodeBin()`
   shipped calling `flowRoot()` (it's a const string, not a function) because
   the change was "type-checked" but `flow up` was never re-run — every fresh
   user's `flow up` then crashed with "flowRoot is not a function". If a
   parallel-work freeze prevents running `flow up`, the change is NOT verified —
   say so and hold the push until it can run.

---

## Architecture (the mental model)

```
Browser (dashboard)  ──HTTP/SSE──▶  Orchestrator (Node, on the machine)  ──spawns──▶  ACP adapter (CLI)  ──▶  agent
```

- **Dashboard** (Next.js 16) is a thin remote — only talks to the orchestrator
  over HTTP/SSE, no machine access. That's why the same UI works on EC2.
- **Orchestrator** (Fastify) is the component with machine access: event
  pipeline (classifier → policy → single-write action layer → audit), the
  agent ACP runtime, settings. It spawns coding agents and injects the graph.
- **Gateway** fronts **FalkorDB** with typed verbs (provenance + confidence,
  dedup, journal). All graph writes go through it — never raw Cypher.
- **Storage tiers:** FalkorDB graph (distilled truth) · SQLite corpus (FTS
  evidence) · systems of record (joined at read time).

**Ports per project** (index N from 0): gateway `7433 + N*10`, orchestrator
`7500 + N*10`, dashboard `7600 + N*10`. Multiple projects share one FalkorDB
via named graphs. Each project is a self-contained `data/projects/<name>/`.

---

## Auth model

- **Local mode (default): no login.** The dashboard auto-authenticates from the
  `FLOW_ADMIN_TOKEN` in its env; stale/foreign cookies are ignored. `FLOW_MODE`
  must be passed to the dashboard process (`flow up` does this).
- **Prod mode:** real login required; cookies are project-specific (a cookie
  for one project is rejected by another).
- Central gate: `src/proxy.ts` (Next 16's renamed middleware convention)
  validates the session via `/api/auth/check` (Node route → this project's own
  orchestrator, so multi-project stays correct even with the shared build).
  401 → login + clear cookie; fails **open** on a network blip so a hiccup
  never mass-logs-out. NOTE: a registered proxy shows up in
  `functions-config-manifest.json` — `middleware-manifest.json` stays empty by
  design (edge-only). Behavioral check for auth changes: prod-mode project,
  no cookie → 307 login, garbage cookie → 307 + cookie cleared, token → in.

---

## Settings & keys

- Per-project settings live in that project's DB, encrypted AES-256-GCM
  (scrypt from `FLOW_ADMIN_TOKEN`). Set them from the dashboard, not `.env`.
- **Machine-global default:** saving the OpenRouter key also writes
  `data/global.json` (0600). A new project's key gate offers to **reuse** it
  (`/v1/onboarding/suggested-key` + `adopt-key`) instead of re-asking.

---

## Agents

- Orchestrator spawns bundled ACP adapters (`claude-agent-acp`, `codex-acp`,
  `opencode acp`) as subprocesses and talks ACP via `@agentclientprotocol/sdk`.
- The read-only graph MCP (`flow-graph`: find/get/read/list only) is injected
  per session; tool calls report node ids back for live brain highlighting.
- Sessions run in the cloned repo at `data/projects/<name>/workspace/repos/<repo>`.
  The session view can open that folder in Finder/VS Code.
- Model/mode come from ACP session config options (advertise
  `session.configOptions` at initialize or agents won't send their model list).
- Scar tissue: Node `spawn` with a default stdin **pipe** hangs opencode
  forever — use `stdio: ["pipe","pipe","pipe"]` and let stdin close cleanly;
  the injected MCP exits on stdin close; adapters are killed on shutdown.

---

## Install prerequisites (the fresh-machine contract)

The worst bug is "I handed it to someone and it didn't install." Keep these true:

- **Node 22+ is the floor** — enforced by a `preinstall` guard
  (`scripts/check-node.mjs`) + `engines` on every package + an `.nvmrc`. Two
  independent reasons: the Claude Code ACP adapter needs 22, and
  `better-sqlite3`'s prebuilt binaries cover 20/22/24 (below/outside that it
  compiles from source and needs a C/C++ toolchain). Bumping a dep? Re-check its
  Node floor **and** its prebuild coverage.
- **No native compile on `npm install`.** `better-sqlite3` is on `^12`
  specifically because it ships prebuilds for current Node — don't downgrade it.
  If install starts running `node-gyp`, something regressed.
- **opencode is bundled** (`opencode-ai` dependency), resolved in
  `orchestrator/src/opencode.ts` from `node_modules` (PATH fallback). Users
  install nothing for the brain. That package pulls only the current platform's
  binary via optionalDependencies — no compile.
- **FalkorDB/Docker is escape-hatched.** `ensureFalkordb()` skips Docker when the
  port is already served or `FALKOR_HOST` is remote, and fails with *guidance*
  (not a stack trace) when Docker is genuinely needed. Never make Docker a hard,
  unexplained requirement.
- **One run story: `flow up`.** Don't reintroduce a root `docker-compose.yml` or
  docs that say "docker compose up" for local — that sends agents/users down a
  competing, half-working path. The compose file lives in `deploy/`, labelled
  experimental.
- **One lockfile.** The root `package-lock.json` is the single source of truth;
  workspace members (orchestrator, graph-gateway, dashboard) must NOT have their
  own — a stale per-workspace lock generated on macOS once recorded only the
  darwin binary for a nested native dep, so clean Linux installs couldn't build
  the dashboard. If a native platform binary goes missing on some OS, regenerate
  the root lock (`rm -rf node_modules package-lock.json && npm install`) and
  check the lock lists ALL platform variants. (`simulators/` is standalone and
  keeps its own lock.)
- **`.npmrc engine-strict=true` is a guard, keep it.** On npm 10, dependency
  install scripts run BEFORE the root `preinstall` hook — so on a bad Node the
  preinstall guard never fires and users get a node-gyp wall. engine-strict
  makes npm refuse up front.
- **`flow up` preflights native deps** (`preflightNativeDeps` in `bin/flow.mjs`):
  an install attempted on another Node leaves an ABI-mismatched module that
  *shadows* a later correct install (nearest `node_modules` wins) — pulling a
  fix doesn't heal a poisoned clone. The preflight probes better-sqlite3 from
  the orchestrator's resolution context and prints the clean-reinstall fix.
- **After any dependency change, re-run the cold-install smoke test**
  (`docs/INSTALL_SMOKE_TEST.md`) — containers, not the dev box, are the only
  honest fresh machine. The dev box lies: it has toolchains, caches, and
  historical `node_modules` layouts a stranger doesn't.

---

## Shipping / public repo

- Keep the source-of-truth changelog current; the public README leads with what
  Flow does, tech stack lives in "How it works" + acknowledgements.
- Before a public push: sanitize real repo names / company names / local
  `/Users/...` paths to generic examples; confirm no secrets in history; prefer
  a clean single-commit history for an initial release.
- Screenshots must not show proprietary code, endpoints, or vulnerabilities —
  use a harmless prompt / demo repo.
- License is **AGPL-3.0**.
- Push is a review-gated, outward-facing action — confirm before pushing.

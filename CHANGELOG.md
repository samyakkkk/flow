# Changelog

All notable changes to Flow. Newest first. Dates are the day work landed.

## [Unreleased]

### Fixed — three more install traps (found by the cold-install smoke test + a real user)
- **Poisoned clones now self-diagnose.** A user who tried Flow before the sqlite fix, then pulled it, still crashed: their first attempt left a `better-sqlite3` built for another Node ABI in `orchestrator/node_modules`, which **shadows** the fresh root install (nearest `node_modules` wins) and kills the orchestrator with a `NODE_MODULE_VERSION` stack trace buried in a log. `flow up` now **preflights the native module exactly the way the orchestrator loads it** and, on an ABI mismatch, stops up front with the exact fix (clean reinstall command). Verified against a simulated poisoned clone.
- **Node 20 is refused before anything confusing happens.** The smoke test proved the `preinstall` guard fires too late on npm 10 — dependency install scripts (native builds) run first and die in a node-gyp/Python wall. Added `.npmrc` with `engine-strict=true`, so npm itself refuses (`EBADENGINE`) before any dependency script runs; the preinstall guard stays as a second layer.
- **Linux installs no longer miss native binaries.** The smoke test's full-boot check failed on Linux: the mac-generated lockfile recorded only the `darwin-arm64` binary for a nested `lightningcss` (the classic npm optional-deps bug), so the dashboard build died on clean Linux machines. Regenerated the root lockfile (all 12 platform binaries now recorded, nesting gone) and **removed the per-workspace `package-lock.json` files** — they were stale mac-generated duplicates that caused this class of bug plus Next.js "multiple lockfiles" warnings; the root lock is the single source of truth (Dockerfiles now install from `package.json`). `simulators/` keeps its own lock (not a workspace member).

### Fixed — `flow up` crashed with "flowRoot is not a function"
- The fresh-clone `nodeBin()` fix called `flowRoot()` as a function, but `bin/lib/paths.mjs` exports it as a **const path string** — so every `flow up` that reached service startup crashed. It shipped because that change was only type-checked (`tsc` doesn't cover the plain-JS CLI) and `flow up` wasn't re-run afterwards. Fixed and verified by actually running `flow up` (all projects + doctor green). Lesson recorded in `soul.md`: CLI changes are verified by *executing* `flow up`, never just parsing/type-checking.

### Fixed — installation that actually works on a fresh machine
The worst failure is handing Flow to someone and the install breaking. A full audit found four traps and fixed each:
- **SQLite no longer fails to install on modern Node.** `better-sqlite3` was pinned to `^9`, which has **no prebuilt binary for Node 22+** — so it compiled from source and died on any machine without a C/C++ toolchain (the reported "sqlite issue on Node far above 20"). Bumped to `^12`, which ships prebuilds for Node 20/22/24 → **no compiler needed**. Verified end to end: the orchestrator's real schema (WAL + FTS5 + triggers + migrations) opens clean under v12 on Node 22.
- **opencode is now bundled — users install nothing.** The graph builder *and* Ask shell out to the `opencode` runtime, so it was a required manual install (`curl … | bash`) that failed silently if missing. It's now a dependency (`opencode-ai`, whose platform binary arrives via optionalDependencies like esbuild — no compile), resolved from `node_modules` with a PATH fallback. `npm install` brings it; the container image gets it too via `npm ci`.
- **The real Node floor is honest and enforced.** `@agentclientprotocol/claude-agent-acp` requires Node **22+**, but `package.json` claimed `>=20`. Bumped `engines` to `>=22` across all packages, added an `.nvmrc`, and a **`preinstall` guard** that fails *loud and early* with the exact fix (`nvm install 22`) instead of a confusing native-build error midway through install.
- **`flow up` explains Docker problems instead of dumping a stack trace.** `ensureFalkordb()` now preflights (Docker installed? daemon up?) with actionable messages, verifies the container actually became reachable, and — crucially — **skips Docker entirely when FalkorDB is already reachable or `FALKOR_HOST` points at your own instance**. So "do I even need Docker?" has an answer: not if you bring your own.

### Fixed — one install story (no more agents reaching for `docker compose`)
The repo told people to run Flow **three** contradictory ways — a root `docker-compose.yml`, a `deploy/local.md` titled *"Quick start (docker compose)"*, and landing-page copy saying *"docker compose up and you're running"* — so an agent setting Flow up naturally used Docker instead of `flow up`.
- **Root `docker-compose.yml` moved to `deploy/`** so `docker compose up` at the repo root no longer auto-discovers it; it now carries a banner that points to `flow up` and is labelled experimental (and its "opencode not bundled" caveat is gone — see above).
- **`deploy/local.md` rewritten** around `flow up` (it predated the CLI entirely). Landing-page snippets and `deploy/ec2.md` updated to match.
- **README**: prerequisites corrected (Node 22+, Docker running *or bring-your-own FalkorDB*, opencode bundled), plus a new **Troubleshooting** section covering each failure mode above.

### Added — real brand icons + share-ready README
- **Brand icons** — GitHub, Linear, Slack, Fireflies, and the coding agents (Anthropic/Claude Code, OpenAI/Codex, OpenCode) now render as proper monochrome inline SVG marks (Simple Icons paths where official; a drawn spark for Fireflies) instead of emoji/geometric glyphs. New `BrandIcon` component; no icon-library dependency.
- **New developer-first README** with real dashboard screenshots (`docs/images/`), a copy-pasteable quickstart, and an honest shipped-vs-roadmap split. Positions Flow as a knowledge-graph + agent-runner that's useful for a solo developer and grows into a team brain.
- **Fixed a confusing key-onboarding error** — pasting a valid OpenRouter key while the project's orchestrator was still booting 500'd into a generic "couldn't reach the server"; the save step now catches the unreachable case and says "the key is valid, but this project is still starting up — try again."

### Fixed — fresh-clone startup ("works on my machine")
- **Orchestrator/gateway/dashboard now start on a clean `npm install`.** The CLI hardcoded `<package>/node_modules/.bin/tsx` (and `next`), but npm **workspaces hoist** shared binaries to the *root* `node_modules`, so on a fresh clone those per-package paths don't exist → services failed to spawn with an empty log ("orchestrator didn't start"). A new `nodeBin()` resolver finds the binary in the package OR the hoisted root, and gives a clear "run npm install" error if truly missing.
- **`/api/repos` no longer trips the Turbopack "dynamic filesystem expression" warning.** The repos-file path was computed at module scope with `path.join(process.cwd(), …)`; it's now resolved at request time (and honors `REPOS_JSON_PATH`).

### Added — live "thinking" indicator in agent sessions
- You now always know when an agent is working, and what it's doing: a pulsing indicator at the bottom of the transcript shows **Thinking… / Consulting the brain… / Running <tool>… / Writing the answer… / Planning…**, derived from the latest ACP activity. Hidden when idle or waiting on a permission prompt.

### Fixed — no more unstyled/stale dashboards + `flow doctor` + `soul.md`
- **Root cause of the "unstyled page":** all project dashboards share one Next.js build, so rebuilding `.next` while a dashboard runs leaves it serving dead chunk hashes (CSS/JS 404/500). Now `flow up` **refreshes every running dashboard** after a rebuild, and always restarts a project's (stateless) dashboard even when "already running" — so a killed, crashed, or stale dashboard self-heals.
- **`flow doctor`** — health-checks every project: services up, every page reachable, and the dashboard's CSS/JS assets actually load (the check that would have caught this). All-green or it tells you what's wrong.
- **`flow rm <name>`** — stop and delete a project (no more hand-`rm` leaving a zombie dashboard on a port).
- **"Already running" is now port-based, not a flaky health probe** — a slow probe used to trigger a second orchestrator on the busy port ("didn't start"); fixed.
- **`soul.md`** — an always-reference operating manual (restart discipline, the shared-build footgun, verification via `flow doctor` + pixels, architecture/ports, auth + key model, agent runtime, shipping rules). Read + update it when procedures change.

### Changed — reuse your OpenRouter key across projects
- **No more re-entering the key for every project.** When you save an OpenRouter key it's remembered as a machine default (in `data/global.json`, 0600). A new project's key gate then shows *"You already gave Flow a key — reuse it?"* with the masked key and two choices: **Use this key** (one click, done) or **Use a different key** for this project. Verified end to end (save → new project offers it → adopt → set). Local-first convenience; each project still stores its own key, so you can diverge per project anytime.

### Changed — friendlier `flow` CLI
- **`flow up <name>` is the one command** — if the project doesn't exist it offers to create it (a typo-guard you can decline), then starts it. No more separate `flow project create` step (still available, plus `flow create` / `flow new` aliases that tolerate `flow create project x`).
- **Clean, human-readable output** — replaced the wall of `pid=… port=… log=…` and per-service `HEALTHY` lines with one tidy line per project: `✓ ready   http://localhost:7610`, a one-line "local mode — you're already signed in" note, and (on failure) just the log path to check. `flow down` and the FalkorDB/Docker noise are quieted the same way.

### Changed — no login step in local mode
- **On your own machine you're no longer asked for a token.** Local mode is single-user on your own box, so the dashboard auto-authenticates from the admin token it already has in its env — open the URL and you're in. A stale or cross-project cookie is ignored locally (the machine's env token is authoritative), so you can never get stuck at a spurious login.
- **Prod stays gated**: an exposed deployment (`--mode prod`) still requires a real login, and prod cookies remain project-specific (a cookie for one project is rejected by another). Verified both modes end to end.

### Fixed — bulletproof session auth (stale cookie no longer breaks pages)
- **Root cause**: middleware only checked that a session cookie *existed*, not that it was *valid*. A stale/expired token then sailed past and 401'd on every page — the home page wrongly showed the "add your OpenRouter key" gate (even with a key set) and agent-session pages just failed to load.
- **Central fix**: middleware now validates the token for real against **this project's own** orchestrator (via a Node `/api/auth/check` route, so per-project `ORCHESTRATOR_URL` is always correct even though all dashboards share one build) and redirects to login + clears the cookie on an actual 401. Fails **open** on a network blip so a momentary orchestrator hiccup never logs everyone out.
- **Multi-project isolation verified**: a cookie for project A is rejected by project B and bounced to B's login; bad/stale cookies → login; each project's valid cookie renders its own dashboard (7-point test).
- Defense in depth: home + agent-session pages also redirect to login on a 401 instead of degrading; session lifetime raised from 24h to 30 days (it's a tool you leave open).

### Added — open the agent's working folder
- **Finder / VS Code / copy-path** in the session view — every agent session works in a cloned repo under `data/projects/…/repos/<repo>`, which nobody would find on their own. The session header now shows the path and one-click opens it in Finder (Explorer / xdg-open on Linux/Windows) or VS Code (`code`, with a macOS app-bundle fallback). Local-mode convenience; the orchestrator launches the app, the path comes from the session record (never the client).

### Added — model selection per agent session
- **Pick the model** (and reasoning/effort level) from the session header, per ACP session config options: Claude Code (5 models + effort), Codex (2 models + reasoning effort), OpenCode (500+ models). Selecting one calls `session/set_config_option` live; the choice persists and survives reload. Required advertising the `session.configOptions` client capability at initialize — without it the agents don't send their model list.
- **Fixed `flow down` leaving the orchestrator alive** — pids.json goes stale after manual restarts/crashes, so `down` now also kills whatever still holds each project port (the orchestrator surviving a restart meant the next `up` silently ran old code).

### Added — Agents v1: run your coding agents from Flow
- **Agents page** — every coding agent installed on the machine (Claude Code, Codex, OpenCode) with live detection, plus a task kickoff form (agent × connected repo × prompt). Missing agents show install hints.
- **Live session view** — streaming transcript (messages, collapsible thinking, tool rows with flow-graph calls highlighted 🧠, plan checklist), steering input (follow-ups when idle; interrupts and redirects mid-run), Stop, real permission cards (Allow / Always allow / Reject from the browser), agent mode dropdown (e.g. Claude's Manual/Auto), archived state after restarts with full transcript replay from JSONL.
- **The brain lights up as agents use it** — the session view's graph panel highlights the exact nodes the agent queries, live ("7 nodes consulted by this session"), and the transcript shows "consulted the brain" markers with the node ids. The graph is visibly the center of the experience.
- Verified with real sessions on all three backends: Claude Code (permissions + steering + a genuine security finding in api-service), OpenCode (contract mapping across both repos, 9 graph calls), Codex (protocol works incl. modes; account was usage-limited — the real reason now surfaces from adapter stderr instead of "Internal error").
- **Long-session performance** — replaying 700+ transcript events one render at a time froze the page: SSE events now batch-flush (~90ms) client-side, and bulky tool payloads (file bodies, up to 56KB per event) are stripped from the wire while the JSONL transcript keeps everything.
- **No process leaks** — the injected MCP exits when its agent goes away, and the orchestrator kills adapter subprocesses on shutdown (finished sessions had been leaving orphans that eventually starved the machine).
- **Orchestrator ACP runtime** (`agents/runtime.ts`, `agents/routes.ts`): detects installed agents (Claude Code / Codex / OpenCode), spawns their ACP adapters, creates sessions in connected-repo checkouts, streams every session event over SSE, and relays steering — follow-up prompts (queue + cancel-current), stop, permission replies, mode changes. Dashboard never spawns processes; everything rides the orchestrator HTTP API (cloud mode later = same API).
- **Read-only graph MCP injected per session** — every agent session gets `flow-graph` (find_entity / get_entity / read_query / list_schema only); each tool call is reported back with the graph node ids it touched, for live brain highlighting. Proven end-to-end with a real opencode session: 3 graph calls, node ids captured, grounded answer (handler.ts:100), clean end_turn.

### Docs — agent-dispatch architecture decided (Shellular + ACP + MCP)
- `docs/AGENT_DISPATCH.md`: Shellular is Flow's agent-execution plane. Flow acts as a headless Shellular client (relay + libsodium, `AI_SESSION_CREATE` with per-session `mcpServers` injection — verified in claude-agent-acp, codex-acp, and opencode sources) to trigger coding-agent tasks on any paired machine and stream progress back; the gateway grows an HTTP MCP endpoint; repos get MCP config written on connect; `flow acp` exposes the answerer as an agent inside Shellular/Zed. Roadmap reordered accordingly.

### Changed — brain graph now uses FalkorDB's own renderer (semantic zoom)
- **Swapped cytoscape for `@falkordb/canvas`** — the exact web component FalkorDB's browser uses (force-graph + d3-force: charge −400, collision = node size + padding, weak centering). The condensed hairball is gone; the graph settles into a spread-out constellation with degree-sized, type-colored nodes.
- **Semantic zoom** — zooming in spreads nodes apart on screen and reveals name labels inside the circles (level-of-detail: labels/arrows are hidden when zoomed out, appear past zoom 1), so you can focus on individual nodes as you dive in.
- **Fit-to-constellation** — isolated nodes drift to the edges under charge; the initial fit now frames the connected cluster instead of letting outliers shrink it to a corner.
- **Stable refreshes** — poll updates diff the data and use position-preserving merges, so the constellation never re-randomizes or jitters while indexing runs. Node click → info card and Ask-view cited-node highlighting (accent + dimming) carried over.

### Fixed — agent hangs, crash recovery, brain viz (found during first real demo run)
- **Root-caused every orchestrator-spawned agent hang**: Node `spawn` left stdin an open pipe and opencode waited on it forever (0 output → timeout). One line (`stdio:["ignore",…]`) — answers went from 10-min timeouts to ~80s.
- **Answer jobs now parse the answerer's structured JSON** (answer_md / citations / confidence) from the transcript instead of dumping raw text with citations hardcoded empty; raw-text fallback preserved.
- **Brain graph viz was empty despite a full graph**: the overview route sent `{query}` (gateway wants `{cypher}`) and parsed the wrong node shape (FalkorDB `id` is an internal int; real id/name are in `properties`, label in `labels[0]`). Now renders (118 nodes · 245 edges on demo).
- **Per-project agent gateway routing** (`GRAPH_GATEWAY_URL` injected) so builders write to the right graph; index/enrich timeout 45min; staggered process starts (boot-recovery "database is locked").

### Added — Home as the source-management hub + live indexing feedback
- **All source management on Home** — GitHub card lists connected repos by name with per-repo status (indexing / indexed / queued), "+ Add repositories" inline picker; Linear/Fireflies connect inline (green "Connected" when a key is set); meeting-notes upload; Slack locked in local mode. The separate connections page is now secondary.
- **"Updating the brain…" overlay** — while any repo is indexing, the graph canvas shows a pulsing accent indicator and the partial graph dims, so you can see work happening. Graph polls every 5s during indexing.
- **Activity shows real names** — repo-connect rows read the repo name from audit detail (was showing job UUIDs).

### Added — the new dashboard experience (per approved UX spec)
- **Home is a guided state machine**: no key → the "Flow needs a brain" gate; key set → friendly source cards (GitHub picker, Linear, Fireflies, meeting notes; Slack locked in local mode); indexing → "Reading your sources…" with live per-source status; alive → the brain front and center.
- **The brain graph is the hero** — live-updating force graph on a dark canvas, type-colored, click a node for a plain-language card; beautiful empty state. (Fixed a flexbox collapse that rendered it as a strip.)
- **Floating "Ask Flow" bar on every page** → Ask view with sanitized markdown answers, plain-phrase confidence, citation chips, and the answer's subgraph highlighted.
- **Humanized Activity** — a timeline of sentences ("Connected api-service — indexing now"); noise hidden entirely; raw log behind an Advanced toggle. Source labels never leak internal keys.
- **Quiet menu** — Home + Ask primary; Sources/Automations/Activity/Settings as a secondary cluster. 68 smoke checks.

### Added — LLM & event observability
- Every live classifier call (full prompt, raw response, model, latency, per-attempt retries, errors) and every opencode job (summary row + complete JSONL transcript at `data/.../job-logs/<job>.jsonl`, stderr on failure) is recorded. Query via `GET /v1/llmlog?kind=&ref=`. Joined with the audit log, events table, gateway journal, and per-service logs, every decision is traceable end to end.

### Added — UX & design system
- **Design system** (`docs/DESIGN.md`) — warm editorial language (cream paper, single yellow accent, Lora serif, Space Mono labels) with shared primitives; applied across the dashboard.
- **UX spec** (`docs/UX.md`, user-approved) — the dashboard as a guided state machine: key gate → connect sources → watch the brain build → alive; floating Ask bar; humanized activity.
- **State 0 "Flow needs a brain"** — first-run OpenRouter key gate with live validation; nothing else is reachable until the brain works.

### Fixed — repo connect pipeline
- **Connecting a repo no longer gets "classified as noise"** — the dashboard's repo-connect action was routed through the LLM classifier (a button click is not language); now handled deterministically: register → clone (async, private repos via GITHUB_TOKEN, token never persisted) → index job. Root causes fixed alongside: live classifier is now the production default (fixture replay was shipping as prod behavior behind the misnamed `FLOW_TEST_LIVE` flag, mislabeling everything as low-confidence noise); a missing OpenRouter key degrades with an explicit "add it in Settings" reason; fixture recording no longer writes into the source tree in production.

### Fixed — multi-project dashboards
- Next.js allows only one `next dev` per directory, so a second project's dashboard silently failed to start. Dashboards now share one production build (auto-rebuilt when source changes) and each runs `next start -p <port>`. `flow up` also health-checks the dashboard, so a failure is loud.

### Added — settings in the dashboard
- `/settings` page + `GET/PUT /v1/settings`: all config (OpenRouter key, models, integration keys, poll intervals, confidence floor) viewable/editable in the UI. Secrets AES-256-GCM-encrypted in the project DB, masked in responses, changes audited (values never logged). Precedence: dashboard-set > env > default. **Hot-apply**: adding a key starts its poller immediately (proven live against Linear). `.env` now holds only the bootstrap admin token.

### Docs
- Adopt `CHANGELOG.md` + `ROADMAP.md` as the tracking docs (newest first); durable design consolidated into `docs/ARCHITECTURE.md`. Retired the overnight-build scaffolding docs.

## 2026-07-06 — Multi-project & install shape

### Added
- **`flow` CLI** — `project create` / `up` / `down` / `ls`. Per-project folders under `data/projects/<name>/` (project.json, `.env` with auto-generated admin token, `workspace/.opencode` from template, `repos/`). Multiple projects run side-by-side on port triplets; FalkorDB shared via named graphs.
- **Local/prod mode gating** — `GET /v1/mode`; Slack adapter refuses to boot in local mode; dashboard shows Slack as "Always-on only — deploy to enable."
- **Poll-since-cursor ingestion engine** — the single ingestion mechanism. GitHub / Linear / Fireflies pollers, `poll_cursors` table, `GET /v1/ingest/status`, catching-up indicator. Webhooks reduced to an optional "poll now" nudge.
- **Dashboard repo picker** — gh CLI → PAT → none fallback, searchable checkbox list, indexed-state badges; mode badge; live ingest-status panel.

### Changed
- **Unified into one repo** — `graph-gateway/` and `index-workspace/` moved inside `flow/`; all cross-directory paths env-driven.

### Fixed
- `flow project create` now generates a per-project `FLOW_ADMIN_TOKEN` (was falling back to a shared insecure default); `.env` written `0600`.

## 2026-07-05 — Overnight v1 build

### Added
- **Orchestrator** — Fastify service: event ingest, LLM classifier (fixture-replayable), policy toggle matrix, single-write action layer, outbox, SQLite corpus (FTS5), job queue, audit log.
- **graph-gateway** — FalkorDB behind typed verbs (find/upsert/relate/get/read/merge/schema), provenance-required writes, dedup gate, append-only journal, HTTP + MCP.
- **Integrations** — Slack (Bolt Socket Mode), Linear (incl. idempotent CONTEXT BY FLOW), GitHub (webhook + poll), meetings upload, outbox drainer. Verified against live Linear + GitHub.
- **Notify tool + session-per-chat (G10)** — scoped notify with budget pushback; thread↔opencode-session binding; real `--session` resume verified.
- **Dashboard** — login, connections, permissions matrix, ask + cytoscape graph viz, activity, repos.
- **Simulators** — 40 scenarios across 3 workspaces proving policy divergence + isolation; Linear mock.
- **Landing page**, **docker-compose + EC2/local deploy docs**, **`verify-all.sh`**, **155-scenario spec** (`docs/scenarios.md`).

### Fixed (review pass)
- **graphwrite hit nonexistent gateway paths** — every knowledge-graph write 404'd (masked by a permissive test stub). Corrected to `/v1/verbs/*` with proper provenance; proven end-to-end against the live gateway.
- **Dashboard pages served unauthenticated** — auth middleware was never wired (misfiled). Fixed; smoke test hardened.
- Config store XOR→AES-256-GCM (stored plaintext on empty token). `spawnSync`→async spawn (froze event loop). Secret scan before DB insert (TOCTOU) + meeting-segment secret filter. Job-scoped notify token instead of admin token in agent subprocess. Crash stall-recovery on boot. Timing-safe token compare.

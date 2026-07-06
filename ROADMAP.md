# Flow — Roadmap

What's shipped, what's next. See `CHANGELOG.md` for dated change history and
`docs/ARCHITECTURE.md` for the design.

## In progress — polish pass on the new UX
Core UX overhaul SHIPPED (see changelog): state-machine home, brain-graph hero, floating Ask bar, humanized activity. Remaining polish: state-detection nuances (sources vs repos), middleware→proxy rename (Next 16 deprecation), real end-to-end walkthrough with a fresh user.

## Shipped 2026-07-07 — Agents v1 (local)
Coding agents (Claude Code / Codex / OpenCode) run from the dashboard via the orchestrator's ACP runtime: kickoff, live streaming, steering, permissions, modes, replay; read-only flow-graph MCP injected per session with live brain highlighting. See CHANGELOG. Next for agents: PR-first task templates, resume sessions across restarts (loadSession), Linear-ticket → agent dispatch, cloud mode (containers behind the same API).

## Next — agent dispatch & MCP exposure (decided 2026-07-06, see docs/AGENT_DISPATCH.md)
Shellular becomes Flow's agent-execution plane; Flow drives coding agents as a headless Shellular client and exposes the graph to them via MCP. In order:
1. **Gateway HTTP MCP endpoint** (streamable-http, bearer token, read-only default for external callers) alongside the existing stdio adapter.
2. **Per-repo MCP config on connect** (`.mcp.json` / `opencode.json` / `.codex/config.toml`) + `flow mcp install` for user scope — users' own agents get graph tools.
3. **Dispatch v1 via Shellular** — `shellular-client` module (relay ws + libsodium), Machines pairing card, trigger a Claude Code task from the dashboard with Flow MCP injected per session (ACP `session/new mcpServers`), progress streamed into Activity + job transcripts.
4. **`flow acp`** — answerer as an ACP agent, registerable in Shellular/Zed as a custom agent (trigger Flow from their interfaces).
5. **Listener ingestion (opt-in)** — Shellular's session-watcher/notify-bridge events (user-started agent sessions) → Flow event pipeline → graph.

## Next (P1–P3)

### P1 — One-command install (`install.sh` / `get.flow.sh`)
Single script installs Node + opencode + Docker (FalkorDB) and puts `flow` on PATH; installs only what's missing. **Same script for laptop and EC2.** End-user experience: `curl -fsSL get.flow.sh | bash` → `flow project create` → `flow up`. No clone, no npm link (contributor-only).

### P2 — Project migration (`flow export` / `flow import`)
`export` bundles a project's FalkorDB graph + project.json + .env + flow.db; `import` restores on the target. Cloned repos re-clone from the registry (derived state). Migrate local→EC2 by moving one bundle; graph + human-corrected claims transfer intact.

### P3 — EC2 always-on (part of install, prod mode)
systemd per project (Restart=always + enable) → crashes and reboots self-heal, no manual `flow up`. EBS-persist + nightly snapshot → instance loss = ~5-min restore. Slack catch-up-on-reconnect (backfill via `conversations.history` since last-seen) → downtime is delayed, not lost. Caddy TLS, only dashboard public.

## Later — single control-plane dashboard
One dashboard per instance managing all projects (create/start/stop from UI, project switcher). Deferred by user decision — per-project URLs listed by `flow up` are fine for now.

## Later (P4 — monetization / managed)

GitHub App backend (no PAT) for managed. CloudFormation "Launch Stack" URL for one-click deploy to the user's own AWS (never hold their creds). Managed hosting as single-tenant instances (keeps the SSH-inspect + audit-log trust story). Revenue = convenience of running the always-on box, not the feature gate (self-hosters unlock free — that's the funnel).

## Backlog / quality (non-blocking)

Semantic (embeddings) corpus search alongside FTS · gateway-enforced biz-cannot-overwrite-code (currently actor-prefix convention) · Slack `command` classification → real actions · policy cache · marked→DOMPurify on ask page · docker ports → 127.0.0.1 bind · cross-project shared repo object store (clone-twice is fine until it isn't) · rename `FLOW_TEST_LIVE` (it gates the *production* live classifier — misleading name).

## Out of scope (v1)

Multi-user auth/SSO · eve migration. (MCP server exposure graduated to "Next — agent dispatch".)

## Shipped

- **Knowledge graph core** — repos indexed into FalkorDB via a governed gateway (typed verbs, provenance + confidence on every claim, dedup at write time, append-only journal). OpenCode agents build/enrich/answer.
- **Orchestrator** — event bus → LLM classifier → policy toggle matrix (auto/propose/off) → single-write action layer → outbox. SQLite corpus (FTS), job queue, audit log.
- **Integrations** — Slack (Socket Mode, prod-only), GitHub / Linear / Fireflies (poll-since-cursor), meeting upload. Linear CONTEXT BY FLOW (idempotent). Notify tool + session-per-chat.
- **Dashboard** — login, connections + repo picker (gh CLI / PAT), permissions matrix, ask page with graph viz, activity/audit, catching-up ingest panel, local/prod mode badge, **Settings page: all config (keys, models, intervals) editable in the UI, secrets encrypted, changes hot-apply (pollers start on key add, no restart)**. Only the bootstrap admin token lives in a file.
- **`flow` CLI** — `project create` / `up` / `down` / `ls`; per-project folders, auto-generated admin token, multiple projects side-by-side on port triplets, shared FalkorDB via named graphs.
- **Mode gating** — local = build/try (Slack locked "deploy to enable"); prod = always-on ambient.
- **Verification** — 72 orchestrator tests, 40 multi-workspace simulator scenarios, dashboard smoke, `verify-all.sh` (4/4). 155-scenario spec in `docs/scenarios.md`.


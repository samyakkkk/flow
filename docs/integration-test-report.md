# Harness Integration Test Report — overnight run 2026-08-06

Executed against the isolated dev deployment **flowtest** (this worktree,
`FLOW_PORT_OFFSET=1000`: dashboard :8600, orchestrator :8500, gateway :8433 —
your running Flow services were never touched). Left **running** so you can
inspect everything: http://localhost:8600/flowtest → captured sessions are in
the DB (`agent_sessions` rows `ext-*`). Test repos live under
`~/flow-integration-tests/<tool>-repo`, each bound via `flow setup flowtest`.

Oracle for every PASS below: a unique sentinel (`FLOW-TEST-<tool>-<n>`) sent
through the real tool, then found via
`GET /v1/ingest/sessions?contains=<sentinel>` with the right repo + content.

## Result matrix

| Tool | Capture (hooks → ingest → distiller) | Serve (flow-graph MCP) | Notes |
|---|---|---|---|
| Claude Code 2.1.170 | ✅ PASS (headless `-p`; prompt+response+close) | ✅ PASS — live `orient` returned graph output, zero prompts (pre-approved read-only tools) | zero taps needed |
| Codex CLI 0.144.5 | ✅ PASS (`codex exec`; needed `--dangerously-bypass-hook-trust` headless) | ✅ PASS — live `orient` via project `.codex/config.toml` | one-time `/hooks` trust per repo (morning tap) |
| opencode 1.17.20 | ✅ PASS (plugin on `session.idle`, full message list) | ✅ registered + connected (`opencode mcp`) | none |
| Gemini CLI 0.53.1 | ✅ PASS (headless `-p`; `AfterAgent` carries prompt+response) | ✅ registered + Connected (`gemini mcp list`) | first-run "hooks will be executed" notice |
| Cursor (Agents window) | ✅ PASS (project `.cursor/hooks.json`, driven via CDP) | 🟡 rendered (`.cursor/mcp.json`) — needs one interactive MCP approval | morning tap |
| Antigravity IDE 1.107.0 | ❌ hooks not executed (repo `.agents/hooks.json` AND global `~/.gemini/config/hooks.json`, both doc-conform; agent ran fine, shim never invoked) | ✅ PASS — live `orient` via `.agents/mcp_config.json`, "always allow" saved | see follow-up below |
| VS Code Copilot / Copilot CLI | 🟡 artifacts inherited from Claude files (documented compat) — runtime untested (not signed in) | 🟡 untested | optional morning check |

## Cross-cutting checks

- **Self-capture guard**: session with `FLOW_SESSION_ID` set → NOT captured. PASS
- **Scoping/bleed**: each repo's sessions landed only under its own repo name;
  binding is baked per-folder at setup (no call-time resolution). PASS
- **Idempotency**: `flow setup` re-run → all artifacts byte-identical. PASS
- **Uninstall**: pre-seeded repo (own CLAUDE.md + foreign `.mcp.json` entry) →
  setup → `--remove` → **byte-identical** restore, incl. deleting created files
  and pruning empty dirs. PASS
- **Personal mode**: `git status` clean after setup (`.git/info/exclude`). PASS
- **Distiller integration**: closed captured sessions were consumed by the real
  distiller (`last_distilled_seq` advanced; 0 observations is correct for
  trivial test prompts). Idle-ending sessions (codex/opencode/cursor) distill
  via the 45-min idle sweep by design. PASS
- **Unit suites**: orchestrator 282/282 (incl. 10 ingest + 6 shim Ring-0 tests
  on real recorded payloads). PASS
- **Server-side dedupe**: re-posting identical hook events appends nothing. PASS

## What shipped (commits on this branch)

1. `ingest:` POST `/v1/ingest/hook` + `/v1/ingest/opencode` + sessions oracle —
   dialect adapters normalize into the exact SessionEvent shapes the existing
   distiller pipeline consumes (zero distiller changes).
2. `capture:` `~/.flow/bin/flow-hook` shim — zero-dep, redacts secrets
   client-side, 2.5s deadline, exit-0-always; Ring-0 tested.
3. `cli:` `flow setup <project>` + materializer — four atoms rendered into six
   tools' dialects; `~/.flow/bin/flow-mcp` stdio wrapper resolves project env
   from `~/.flow/config.json`; manifest + originals snapshot; `--share`,
   `--harness`, `--remove`.
4. Hardening: byte-identical uninstall, empty-shell cleanup, originals capture.

## Morning checklist (only you can do these)

1. **Codex trust (one per repo)**: open `codex` in a connected repo, run
   `/hooks`, approve the flow hooks. (Headless tests used the bypass flag.)
2. **Cursor MCP approval (once)**: Cursor → Settings → MCP → approve
   `flow-graph`. Capture already works without it.
3. **Try it for real**: run any tool in `~/flow-integration-tests/*-repo`, then
   open http://localhost:8600/flowtest — your session appears; ask a question
   in a fresh session and `orient` knows the repo.
4. **To connect a real repo**: `cd <repo> && flow setup <project>` (from the
   main checkout's `flow`; tonight's binary is this worktree's `bin/flow.mjs`).
5. Optional: sign into VS Code Copilot and repeat the sentinel test.

## Follow-ups / known gaps

- **Antigravity capture**: hooks (both locations, doc-conform schema) never
  executed on IDE 1.107.0 while the agent ran fine — likely version/flag gating
  of the hooks feature. Options: retest on newer build, check for an enable
  setting, or fall back to brain-dir ingestion
  (`~/.gemini/antigravity/brain/<id>/`). MCP serve already works.
- **Codex hook trust**: hook definitions hash per repo (baked `--project` args)
  → one `/hooks` review per repo. If that's too much friction, a global
  `~/.codex/hooks.json` entry with a repo-resolving shim is the alternative
  (server-side git-remote resolution — same path as the future org plugin).
- **Codex `SessionEnd`** didn't fire under `codex exec` (Stop did) — sessions
  close via idle sweep; harmless, worth a retest on newer codex.
- **Cursor stop-hook**: we register `afterAgentResponse` (carries text; `stop`
  doesn't). Multi-turn transcripts arrive turn-by-turn. Watch Cursor's churn.
- **`flow up` should re-run drift repair**: manifest versions exist
  (`~/.flow/integrations.json`); wiring auto-repair into boot is a small
  follow-up. Today: re-run `flow setup` (idempotent) after Flow updates.
- **EC2 phase (tomorrow)**: HTTP MCP + OAuth on public URL (today's atom 2 is
  stdio, local-only), remote ingest auth per user, claude.ai/ChatGPT courier
  (connector + skill ZIP), Connections page, org plugin channel.

## Machine state touched (all reversible)

- `~/.flow/` — bin/flow-hook, bin/flow-mcp, config.json (flowtest entry),
  integrations.json, logs/.
- `~/.codex/config.toml` — `hooks = true` under `[features]`; trust entries for
  test repos (+ `~/flow-integration-tests/spike`).
- Test repos + spike payload logs: `~/flow-integration-tests/` (fixture source).
- Cursor + Antigravity IDE are running with `--remote-debugging-port` (9333 /
  9444) from tonight's CDP driving — quit/relaunch normally to drop the flag.
- Dev deployment `flowtest` running from this worktree (ports 8433/8500/8600) —
  stop with `FLOW_PORT_OFFSET=1000 node bin/flow.mjs down flowtest` from the
  worktree when done.

# Overnight Plan — Harness Integrations, Local-Only (2026-08-05 → 06)

**Definition of done (morning):** running Claude Code, Codex, opencode, Gemini CLI, Cursor,
or Antigravity in a bound test repo lands that session in the local Flow brain (capture), and
each tool can call Flow's MCP tools (serve). `docs/integration-test-report.md` proves it
per tool with evidence, plus a short morning checklist of anything only Samyak can tap.

**Scope tonight:** local runner only (`flow setup <projectName>`, bindings baked in, no
call-time resolution). **Out of scope:** EC2/public deployment, claude.ai/ChatGPT courier
(needs public HTTPS — tomorrow, with EC2), org plugin channel, VS Code Copilot sign-in
(its files are inherited from Claude Code's; noted in report as untested-but-materialized).

**Installed inventory (verified):** claude 2.1.170 · codex 0.144.5 · opencode 1.17.20 ·
gemini 0.53.1 · Cursor + Antigravity installed as apps (CLIs to be probed in Phase 0) ·
config dirs present for all incl. `~/.copilot` · `~/.flow` exists.

---

## Ground rules (hold all night)

- **Never** touch the user's running Flow services. Dev orchestrator/gateway run from THIS
  worktree on separate ports (e.g. 7610+) with their own data dir.
- All live tests happen in dedicated repos under `~/flow-integration-tests/<tool>-repo`,
  each bound to its own throwaway test project. No real repo gets test artifacts.
- Writes to user-global config (`~/.claude`, `~/.codex`, …) are additive, marker-delimited,
  logged in the report, and reversible via `flow setup --remove`. Prefer per-repo config
  wherever the tool supports it.
- Hook shims must never break a session: exit 0 on any error, `--max-time` on uploads.
- Commit checkpoint on this branch at the end of every phase; push the branch at the end.
- If a tool blocks hard after two fallbacks, mark it NEEDS-TAP in the report and move on.
  Maximum coverage beats all-or-nothing.

## Test oracle (used by every phase)

Server-side, deterministic: each test session carries a unique sentinel
(`FLOW-TEST-<tool>-<nonce>`). PASS = sentinel appears in the dev orchestrator's ingest
store for the **correct project** within timeout, with harness label + external session id;
re-run advances the watermark with **zero duplicates**. Serve PASS = the tool lists Flow's
MCP server AND a prompted "call orient" session produces a logged MCP request server-side.

---

## Phase 0 — Recon & de-risking spikes (~1h)

- [ ] Map orchestrator: route registration, auth middleware/tokens, `agent-sessions/*.jsonl`
      writer + SlimEvent shape, distiller trigger on close/idle, `last_distilled_seq`
      watermark, projects/sources registry lookup by name, `work_folders` table.
- [ ] Map CLI: command registration pattern, `~/.flow` config shape, orchestrator base
      URL/auth, natural home for `flow setup`.
- [ ] Find dashboard's existing one-tap-install / managed-block writer code (recent banner
      work) — reuse for the materializer rather than rewriting.
- [ ] Locate gateway MCP endpoint (per-project URL shape + auth) to embed in atom 2.
- [ ] Probe GUI tools: does `cursor-agent` exist in Cursor.app? Antigravity CLI binary?
      Add to PATH inventory.
- [ ] **Spike (critical, before building anything):** minimal echo-hook per tool; verify
      hooks actually fire under headless `claude -p`, `codex exec`, `gemini -p`, and
      opencode plugin events under `opencode run`. Record real hook payloads → these become
      Ring 0 fixtures. Fallback noted per tool (PTY drive) if headless doesn't fire.
- [ ] Boot dev orchestrator from this worktree on alternate ports; confirm isolation from
      the running stack.

## Phase 1 — Ingest endpoint (orchestrator)

- [ ] `POST /v1/ingest/transcripts` + lifecycle events, authenticated by user token
      (same auth story as existing local endpoints).
- [ ] Harness-dialect → SlimEvent adapters (claude-code, codex, cursor, gemini,
      antigravity, opencode, generic). Version-tolerant: prefer documented payload fields,
      never hard-fail on unknown shapes. Accept both binding styles: project pre-resolved
      by client (tonight's path) AND resolve-from-git-remote (future org-plugin path —
      unregistered repos → inbox, never silent default).
- [ ] Per-external-session byte/seq watermark server-side (mirror of `last_distilled_seq`)
      → idempotent re-posts.
- [ ] Ingested sessions flow into the same distiller path as ACP-run sessions.
- [ ] Fixture-driven tests: post real recorded payloads (from Phase 0 spike) → session
      mirror row + distiller queued; re-post → no dupes.

## Phase 2 — Hook shim (atom 1)

- [ ] `~/.flow/bin/flow-hook`: single Node file, zero deps, `--harness <dialect>`
      `--project <p>` `--remote <name>`; reads hook JSON on stdin; skips Flow-run sessions
      (`FLOW_SESSION_ID`); reads transcript delta via byte-offset watermarks
      (`~/.flow/watermarks.json`); client-side secret redaction (key patterns, env-value
      scrub); POSTs to bound deployment; fail fast + silent, always exit 0.
- [ ] opencode variant: same logic as ~40-line JS plugin (`session.idle` →
      `client.session.messages()` → POST).
- [ ] Ring 0 tests: run shim against recorded fixtures for every dialect; assert normalized
      POST bodies, watermark advance, redaction, exit codes. These run offline forever.

## Phase 3 — `flow setup <projectName>` + materializer (atoms 2–5)

- [ ] `flow setup <projectName>`: validate project against local registry; record folder →
      (local, project) binding (`work_folders` shape); materialize artifacts; default
      personal mode (append written paths to `.git/info/exclude`); `--share` un-excludes;
      `--remove` uninstalls cleanly; idempotent re-runs (second run = zero diff).
- [ ] Version manifest `~/.flow/integrations.json` + drift detection/repair on re-run.
- [ ] Renderers wave 1: **Claude Code** (`.claude/settings.json` hooks → shim, `.mcp.json`,
      `.claude/skills/flow/`), **Codex** (`.codex/hooks.json` — hooks GA/default-on now, no
      feature gate; `config.toml` MCP; `.agents/skills/flow/`; AGENTS.md marker block),
      **opencode** (`.opencode/plugins/flow.ts`, `opencode.json` MCP).
- [ ] Atom 3 (SKILL.md: orient at start, search on surprise, remember at end, skip trivial)
      + atom 4 (3–4 line marker-delimited instruction block) content written once, rendered
      per tool.
- [ ] Codex trust rule enforced by construction: hook line is a frozen one-liner exec'ing
      the versioned shim; pre-trust via config where sanctioned.

## Phase 4 — Ring 1 e2e: Claude Code, Codex, opencode

Per tool, in its own bound test repo:
- [ ] Capture: sentinel session via `claude -p` / `codex exec` / `opencode run` → ingest
      PASS.
- [ ] Watermark: immediate second session → no duplicate events.
- [ ] Skip: session with `FLOW_SESSION_ID` set → NOT captured.
- [ ] Bleed guard: repo A sentinel never appears under project B.
- [ ] Serve: Flow MCP listed (`claude mcp list` / codex config / `opencode` equivalent);
      prompted orient-call session → gateway request logged.
- [ ] Commit checkpoint.

## Phase 5 — Gemini CLI, Cursor, Antigravity

- [ ] Renderers: **Gemini** (`.gemini/settings.json` hooks + mcpServers, GEMINI.md block,
      skills; handle trusted-folder gate), **Cursor** (`.cursor/hooks.json` with
      `"version": 1`, `.cursor/mcp.json`, skill/rule; mind ~40-tool cap — expose ≤3 tools),
      **Antigravity** (`.agents/hooks.json`, `.agents/mcp_config.json`, `.agents/skills/`).
- [ ] Gemini Ring 1 headless (PTY fallback if `-p` doesn't fire hooks).
- [ ] Cursor: try `cursor-agent` CLI first; if hooks don't fire there → Ring 2.
- [ ] Antigravity: CLI if present → Ring 1; else Ring 2.
- [ ] Ring 2 (CDP via agent-browser, both are Electron/VS Code forks): launch app on test
      repo, drive agent panel with sentinel prompt, wait for completion, verify
      server-side; screenshot archived on failure; approve MCP/trust dialogs via CDP where
      they appear. AppleScript only as last-resort for native dialogs.
- [ ] Same per-tool checklist as Phase 4. Commit checkpoint.

## Phase 6 — Hardening & updates story

- [ ] Idempotency: `flow setup` twice → zero diff; corrupted/hand-edited managed block →
      repaired; version bump in manifest → files re-rendered.
- [ ] `flow setup --remove` leaves repo byte-identical to pre-setup (minus
      `.git/info/exclude` line removal).
- [ ] VS Code Copilot inheritance sanity: confirm `.claude/settings.json` hooks +
      `~/.copilot/mcp-config.json` are materialized correctly (runtime untested tonight —
      noted in report).
- [ ] Shim update path: bump shim version, re-run one tool, confirm capture still green
      with no per-repo file changes (proves the fat/thin split).

## Phase 7 — Report, cleanup, handoff

- [ ] `docs/integration-test-report.md`: per-tool matrix (capture / serve / scoping /
      watermark / skip — PASS · FAIL · NEEDS-TAP) + evidence pointers (ingest row ids,
      gateway log lines, screenshots dir).
- [ ] Morning checklist: one-time taps I couldn't automate (likely candidates: Claude Code
      project-MCP approval per repo, Codex `/hooks` trust if config pre-trust insufficient,
      Cursor/VS Code MCP confirm, Gemini folder trust, any GUI login walls) + EC2-day
      items (public MCP URL for courier, connector listing, org plugin).
- [ ] Test repos left in place under `~/flow-integration-tests/` for morning inspection;
      dev stack shut down (dev instance only — never the user's).
- [ ] Final commit + push branch.

## Risk register

| Risk | Fallback |
|---|---|
| Headless mode doesn't fire hooks (any tool) | PTY-drive the interactive TUI |
| `cursor-agent` lacks hook support | Ring 2 CDP on Cursor IDE |
| No Antigravity CLI | Ring 2 CDP |
| Codex trust hash blocks headless | Write trust into `~/.codex/config.toml`; else NEEDS-TAP |
| Gemini trusted-folder gate | Pre-trust via settings; else NEEDS-TAP |
| MCP OAuth prompts block serve tests | Token-in-config for local dev instance (no OAuth needed on localhost) |
| Distiller needs LLM overnight | Acceptance = ingest + queued; full distill spot-checked on 1–2 sessions |
| Transcript format drift vs docs | Adapters keyed on documented hook fields, raw-file parsing defensive |

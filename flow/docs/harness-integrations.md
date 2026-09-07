# Harness Integrations: Capture & Serve Across Coding Tools

_Research + design doc, 2026-08-05. Findings verified against official vendor docs (August 2026)
by parallel research agents; sources linked per section. Decisions in this doc were settled in
discussion with Samyak and are also filed in Flow memory._

## Copilot installation (2026-09-05)

The materializer supports GitHub Copilot CLI and VS Code Copilot as the
`copilot` harness. This installs Flow into the external coding tool; it does
not add an ACP backend or an agent-picker option in Flow.

Run `flow setup <project> --harness copilot` inside a checkout, or rerun
`flow setup <project>` for automatic detection. Detection checks `copilot` on
PATH, `COPILOT_HOME` / `~/.copilot`, and installed GitHub Copilot extensions in
standard VS Code extension directories. `--all` includes Copilot too.

| Artifact | Purpose |
|---|---|
| `.github/hooks/flow.json` | SessionStart, UserPromptSubmit, Stop, SessionEnd capture hooks |
| `.github/mcp.json` | Copilot CLI project MCP registration (`mcpServers`) |
| `.vscode/mcp.json` | VS Code MCP registration (`servers`) |
| `.github/skills/flow/SKILL.md` | Flow memory skill |
| `.github/copilot-instructions.md` | Managed instruction block |

The CLI and VS Code use separate MCP configurations. PascalCase hook names
select Copilot CLI's VS Code-compatible payload dialect. Stop supplies a
transcript path; the shim reads at most the last 256 KiB of that JSONL file,
extracts the latest parent assistant message, and redacts it before upload.
Missing files and unknown records are ignored. Recognized Copilot transcript
headers suppress inherited Claude hooks to avoid duplicate session capture.
VS Code has no SessionEnd hook, so the existing idle distiller handles closure.

Setup preserves existing MCP servers, hooks, instructions, and JSONC comments.
Personal mode excludes the generated artifacts from git; `--share` exposes
them, and `flow setup --remove` removes Flow's entries. Credentials continue
to live in the machine's Flow config. Trust the folder and approve the
`flow-graph` MCP server in each client; organization policies may restrict
MCP or hooks. Remote VS Code extension hosts need Flow installed on that host.

Validation covers setup/removal, JSONC preservation, transcript redaction,
duplicate capture, and ingestion on Node 22. A live authenticated Copilot
session was not available for verification. Transcript formats are not a
stable vendor API. GitHub's hosted Copilot cloud agent requires separate
sandbox setup, credentials, MCP configuration, and firewall access; the local
installer does not provision that environment.

Primary sources checked on 2026-09-05:

- [Copilot CLI MCP configuration and project discovery](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [Copilot hook configuration and payloads](https://docs.github.com/en/copilot/reference/hooks-reference)
- [VS Code hooks](https://code.visualstudio.com/docs/agent-customization/hooks)
- [VS Code transcript producer](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/chat/vscode-node/sessionTranscriptService.ts)
- [Copilot CLI plugins](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)

Copilot also supports packaged plugins. Flow keeps its existing direct config
installation approach, so no marketplace listing or plugin publication is
required.

## 1. Goal & framing

Flow today only captures transcripts of sessions **Flow itself runs** (ACP runtime →
`agent-sessions/<id>.jsonl` → distiller on close/idle). Everything a user does directly in
Claude Code, Cursor, Codex, etc. is invisible to the memory pipeline.

The plan: integrate with each harness's own extension surface so that **every** coding session
in a connected folder feeds the brain, and every agent can read the brain back.

Everything decomposes into a 2×2:

- **Capture (write path)**: transcripts → Flow's distiller.
- **Serve (read path)**: Flow's memory/graph → the agent (MCP tools, skills, instruction files).
- **Mode A**: something of Flow's is installed on the machine (CLI now, Mac app later).
- **Mode B**: zero local footprint (cloud surfaces, non-technical users).

Headline findings:

1. **Hooks-with-`transcript_path` became a de-facto industry standard.** Claude Code, Codex CLI,
   Cursor, VS Code Copilot, Copilot CLI, Gemini CLI, and Google Antigravity ALL ship lifecycle
   hook systems whose JSON payload includes a transcript file path + the project directory.
   Capture requires no daemon anywhere — hooks are ephemeral processes the harness spawns.
2. **The hook/skill formats are converging and partially shared.** VS Code and Copilot CLI parse
   Claude Code's hook format from `.claude/settings.json`. Skills (agentskills.io `SKILL.md`)
   are adopted by Claude Code, claude.ai, Codex, Cursor 2.4+, Copilot, Gemini CLI, Antigravity,
   and opencode — several read each other's skill directories (`.claude/skills`, `.agents/skills`).
3. **Serving converges on one remote MCP server (HTTP + OAuth/token)** — supported by every
   coding tool and both consumer apps.
4. **Consumer apps (claude.ai, ChatGPT) have no passive capture path for individuals.** Only
   manual export or Enterprise-tier compliance APIs. Capture there is model-mediated
   ("agent-as-courier": a skill instructs the model to call `flow.remember`).
5. **Transcript file formats are explicitly unstable everywhere** (Claude Code and Codex docs
   both warn). Parsers must be version-tolerant; prefer documented hook payload fields
   (`prompt`, `last_assistant_message`, `tool_response`).
6. **Cloud coding agents (Copilot coding agent, Cursor cloud agents) execute repo-committed
   hooks inside the vendor's own sandbox** — capture with zero user machine, if the hook POSTs
   to Flow's server.

## 2. Master feasibility chart

"Local script" = ephemeral hook command; no resident process.

| Tool | Capture, local script | Capture, zero-local | Serve memory | Per-folder scoping |
|---|---|---|---|---|
| Claude Code | ✅ hooks + `transcript_path`, `prompt`, `last_assistant_message`, `tool_response` | ✅ native **HTTP hooks** POST payloads to a remote URL | ✅ remote MCP + skills; claude.ai connectors auto-bridge in | ✅ `.claude/`, `.mcp.json` (trust-gated) |
| Codex (CLI/IDE/desktop app) | ✅ hooks **GA, on by default** (opt-out `[features] hooks=false`) + `transcript_path`; fire on all local surfaces incl. ChatGPT desktop app's Codex view; rollouts in `~/.codex/sessions/` | 🟡 hooks also run in Codex cloud ("wherever Codex runs") | ✅ MCP (stdio+HTTP+OAuth), skills (`.agents/skills`), AGENTS.md, MCP `instructions` field | ✅ `.codex/` (trust-gated) |
| Cursor | ✅ hooks (`stop`/`afterAgentResponse`) + `transcript_path`, `workspace_roots`, `conversation_id`, `user_email` | 🟡 cloud agents run repo hooks in Cursor's cloud; v1 API streams transcripts | ✅ MCP (⚠️ ~40-tool cap), skills, rules, `sessionStart` `additional_context` injection | ✅ `.cursor/` (`hooks.json` needs `"version": 1`) |
| VS Code Copilot | ✅ hooks (Preview) + `transcript_path`; also reads `.claude/settings.json` hooks | 🟡 Copilot coding agent runs repo `.github/hooks/` in cloud sandbox (egress unverified) | ✅ MCP (gallery+OAuth), copilot-instructions.md, AGENTS.md, skills, custom agents pinning `flow/*` | ✅ `.vscode/mcp.json`, `.github/hooks/` |
| Copilot CLI | ✅ lifecycle hooks + `transcriptPath`; sessions in SQLite+JSONL under `~/.copilot/` | 🟡 "chronicle" syncs to GitHub cloud, no public read API | ✅ MCP via `.github/mcp.json` or `~/.copilot/mcp-config.json`, skills; separate from VS Code config | ✅ repo `.github/hooks/` |
| Gemini CLI | ✅ hooks (v0.26.0+, Jan 2026): every event has `transcript_path`+`cwd`; `AfterModel` carries full request/response; OTEL bonus channel | ❌ | ✅ MCP (OAuth), GEMINI.md/AGENTS.md, skills | ✅ `.gemini/settings.json` (trusted-folder gated) |
| Antigravity | ✅ hooks (5 events) + `transcriptPath`+`workspacePaths`; brain dirs (`~/.gemini/antigravity*/brain/`) as fallback | ❌ | ✅ MCP (remote+OAuth), skills, AGENTS.md/rules | ✅ `.agents/` dir |
| opencode | ✅ JS plugin: `session.idle` → `client.session.messages()` → POST; `worktree` provided | 🟡 `opencode serve` SSE `/event` streams everything (needs a running server) | ✅ remote MCP (OAuth+DCR), custom tools, skills (reads `.claude/skills`), AGENTS.md; `instructions` accepts remote URLs | ✅ `.opencode/` (weak trust model) |
| ChatGPT app | — | ❌ passive; 🟡 courier via connector+skill. Compliance API = Enterprise/Edu admins only | ✅ custom connector (Developer mode, Plus+); not Free tier | ❌ no folder; Projects identity NOT exposed to connectors |
| claude.ai / Cowork | 🟡 Cowork desktop writes Claude Code-format JSONL to `~/Library/Application Support/Claude/local-agent-mode-sessions/` (undocumented, local sessions only) | ❌ passive; 🟡 courier works — connectors+skills on **all plans incl. Free**. Compliance API = Enterprise only | ✅ custom connectors every plan; skills as ZIP upload; connectors auto-appear in Claude Code | ❌ Projects identity not passed to connectors |

## 3. Per-tool verified details

### Claude Code
- Hooks: every event carries `session_id`, `prompt_id`, `transcript_path`, `cwd`,
  `permission_mode`. `UserPromptSubmit` adds `prompt`; `Stop` adds `last_assistant_message`
  (use this — transcript file is written async and may lag); `PostToolUse` adds `tool_name`,
  `tool_input`, `tool_response`; `SubagentStop` adds `agent_transcript_path`. `SessionEnd`
  default timeout is 1.5s — uploader must be fast or detach.
- **HTTP hooks**: `"type": "http"` POSTs the identical JSON to a URL. The remote endpoint can't
  read `transcript_path`, but `prompt` + `last_assistant_message` + `tool_response` ≈ exactly
  what `slimTranscript` keeps — remote capture is near-lossless for the distiller.
- Transcripts: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. Format explicitly internal
  ("can break on any release" — use hook fields or `/export`).
- Plugins bundle `hooks/hooks.json` + `bin/` executables + `.mcp.json` + `skills/` in one
  directory (`${CLAUDE_PLUGIN_ROOT}` refs). We don't use marketplaces, but the plugin *format*
  and skills-dir auto-load (`~/.claude/skills/<name>/` loads with no marketplace) remain usable.
- MCP: `claude mcp add --transport http <name> <url>`; OAuth. Connectors added on claude.ai
  automatically appear in Claude Code.
- Identity: hooks give `cwd`; MCP stdio servers get `CLAUDE_PROJECT_DIR`; `roots/list` supported.
- Docs: code.claude.com/docs/en/{hooks,sessions,plugins,mcp}.

### Codex (CLI / IDE extension / ChatGPT desktop app)
- Hooks: 11 events (`SessionStart/End`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
  `PostToolUse`, `PreCompact/PostCompact`, `Stop`, `SubagentStart/Stop`). **GA and enabled by
  default** as of Aug 2026 (opt-out `[features] hooks = false`; admins via `requirements.toml`)
  — the `[features] hooks = true` gate is no longer needed. Apply "across CLI, IDE extension,
  ChatGPT desktop app, and cloud — wherever Codex runs" (docs); discovery:
  `~/.codex/{hooks.json,config.toml}` + repo `.codex/`. Common fields `session_id`, `cwd`,
  `hook_event_name`, `model`, `permission_mode` (+ `turn_id` on turn events).
  `transcript_path` is `string|null`, reliably present on `SessionStart/End`,
  `SubagentStart/Stop`. Command hooks only (stdin JSON) — **no HTTP hooks**.
- ChatGPT desktop app (redesigned Jul 16, 2026): global switcher ChatGPT ↔ Codex; inside
  ChatGPT, **Chat vs Work modes** (Work = agentic end-to-end tasks). The Codex view is the
  standard local Codex → our `~/.codex` hooks/MCP cover it with zero extra work. Whether
  ChatGPT-side Work-mode conversations fire Codex hooks is undocumented — treat Work/Chat as
  courier-only until verified.
- Trust: hooks require one-time `/hooks` review; re-trust on every hook-definition change
  (hash-based) → keep the hook a stable one-line shim that execs a versioned script.
  VERIFIED 2026-08-06 (0.144.5): untrusted hooks are skipped SILENTLY; headless runs can use
  `codex exec --dangerously-bypass-hook-trust`. Also `[features] hooks = true` was still
  required on 0.144.5 (GA default-on evidently lands in a newer build), and `SessionEnd` did
  not fire under `codex exec` (Stop did — idle sweep covers close).
- Transcripts: rollouts at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (full conversation;
  note: files are world-readable 0644). `history.jsonl` is prompt history only. Format
  explicitly "not a stable interface".
- `notify` (argv JSON, `agent-turn-complete`): `thread-id`, `turn-id`, `cwd`, `input-messages`,
  `last-assistant-message`. Host-owned; no transcript path.
- Serve: MCP stdio + streamable HTTP, `auth = "oauth"`, per-tool approval modes; MCP servers can
  ship an `instructions` field Codex injects. Skills at `.agents/skills` (repo, walks up) and
  `~/.agents/skills`; AGENTS.md read per folder.
- Config layering: `~/.codex/{hooks.json,config.toml}` + repo `.codex/` (activates only when
  project trusted). Project config cannot override host-owned keys (`notify`, `otel`, auth).
- Docs: developers.openai.com/codex/{hooks,config-reference,config-advanced,mcp,skills}.

### Cursor
- Hooks: 20+ events incl. `sessionStart/End`, `beforeSubmitPrompt`, `stop`,
  `afterAgentResponse`, `afterAgentThought`, `preToolUse/postToolUse`, subagent + tab events.
  Base payload: `conversation_id`, `generation_id`, `model`, `workspace_roots`, `user_email`,
  **`transcript_path`**; env `CURSOR_TRANSCRIPT_PATH`, `CURSOR_PROJECT_DIR`. `stop` can return
  `followup_message`; `sessionStart` can return `additional_context` (deterministic memory
  injection — best serve path). Config: MDM → Team (cloud-synced) → project
  `.cursor/hooks.json` (**must include `"version": 1`**) → user `~/.cursor/hooks.json`.
- Local history: multiple overlapping undocumented stores (`state.vscdb` sqlite,
  `~/.cursor/chats/`, `~/.cursor/projects/*/agent-transcripts/*.jsonl`). Backfill-only;
  SpecStory is prior art.
- Cloud agents: run repo `.cursor/hooks.json` (subset); v1 API streams full transcripts
  (`GET /v1/agents/{id}/runs/{runId}/stream`); admin/analytics APIs expose **no** conversation
  content.
- Serve: MCP stdio/SSE/HTTP + OAuth; project `.cursor/mcp.json`; Roots capability;
  **~40-tool cap across all servers — expose 1–3 tools**. Skills since 2.4; rules `.mdc` +
  AGENTS.md.
- Docs: cursor.com/docs/{hooks,mcp,rules,plugins}, cursor.com/docs/cloud-agent/api.

### VS Code Copilot + Copilot CLI + Copilot coding agent
- VS Code hooks (Preview): 8 events, input includes `transcript_path`, `session_id`, `cwd`,
  `prompt`, `tool_name/tool_input`; stdout can inject `additionalContext` and gate permissions.
  Locations: workspace `.github/hooks/*.json`, user `~/.copilot/hooks`, **and it parses
  `.claude/settings.json`** (Claude compat; matcher syntax currently ignored).
- Copilot CLI: 14 hook events, `transcriptPath` in payloads; sessions at
  `~/.copilot/session-state/<id>/events.jsonl` + `session-store.db` (SQLite FTS5).
  **"Chronicle" syncs sessions to GitHub cloud by default** (`"remoteExport": false` to opt
  out) — GitHub is building first-party cross-surface session memory; competitive signal.
- Coding agent (cloud): runs repo `.github/hooks/*.json` inside its sandbox (`transcriptPath`
  available; egress for POSTs unverified). MCP config lives in repo Settings (admin-only, no
  OAuth, `COPILOT_MCP_*` secrets). No public API for session logs.
- Serve: MCP in VS Code (`.vscode/mcp.json`, with a `servers` map; gallery;
  `code --add-mcp`; `vscode:mcp/install` deep links exist). Copilot CLI separately
  loads `.mcp.json`, `.github/mcp.json`, or user `~/.copilot/mcp-config.json`;
  `.github/copilot-instructions.md`; AGENTS.md; skills (`.github/skills`, also reads
  `.claude/skills` and `.agents/skills`); custom agents can pin `server/tool` in frontmatter.
- Enterprise: MCP registry allowlists (VS Code enforces at runtime), `ChatMCP` device policy.
- Docs: code.visualstudio.com/docs/agent-customization/{hooks,mcp-servers,custom-instructions},
  docs.github.com/copilot/reference/hooks-reference.

### Gemini CLI
- Hooks (v0.26.0+, Jan 2026): `BeforeTool/AfterTool`, `BeforeAgent/AfterAgent`,
  `BeforeModel/AfterModel`, `BeforeToolSelection`, `SessionStart/End`, `Notification`,
  `PreCompress`. **Every hook gets `session_id`, `transcript_path`, `cwd`.** `AfterModel`
  carries the full `llm_request`/`llm_response`. Config in `settings.json` `hooks` object
  (user or project `.gemini/`).
- Sessions: `~/.gemini/tmp/<project_hash>/chats/` (full transcripts, 30d default retention);
  checkpoints as JSON. OTEL telemetry (`telemetry.logPrompts` default true) is a secondary
  content channel.
- Serve: MCP stdio (`cwd` field)/SSE/HTTP + OAuth with dynamic client registration;
  hierarchical GEMINI.md (filename configurable to AGENTS.md); skills; **extensions** bundle
  `mcpServers` + `hooks/hooks.json` + context + commands + skills in one
  `gemini extensions install <github-url>` (best single artifact of all tools — usable without
  a marketplace since it installs from any git URL/local path).
- Open source (Apache 2.0) — formats confirmable from source. Enterprise: system settings
  overrides, `mcp.allowed` allowlists, trusted folders.
- Docs: geminicli.com/docs/{hooks/reference,cli/session-management,tools/mcp-server,extensions}.

### Google Antigravity
- ⚠️ VERIFIED GAP 2026-08-06: on Antigravity IDE 1.107.0, doc-conform hooks.json (named-group
  schema) in BOTH `.agents/` and `~/.gemini/config/` was never executed while agent sessions
  ran fine — hooks appear version/flag-gated. MCP serve works (live orient). Capture fallback:
  brain-dir ingestion.
- 2026-09-06: Fixed lifecycle handler format: `PreInvocation`, `PostInvocation`
  and `Stop` use flat handlers; only tool events use matcher/groups. Real
  Antigravity cloud prompt/answer capture now passes. The older gap below
  must not be taken as evidence that current hooks are unsupported.
- Hooks: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. Payload:
  `conversationId`, `workspacePaths`, **`transcriptPath`**
  (`<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`),
  `artifactDirectoryPath`, `modelName`. Config: `.agents/hooks.json` (workspace) or
  `~/.gemini/config/` (global).
- Brain dirs on disk: `~/.gemini/antigravity/brain/<id>/` (IDE),
  `~/.gemini/antigravity-cli/brain/<id>/` (CLI; `transcript_full.jsonl` = untruncated).
  Undocumented; use hooks contract instead where possible.
- Serve: MCP local + remote (`serverUrl`, OAuth/DCR); config
  `~/.gemini/config/mcp_config.json` (shared IDE+CLI) or `.agents/mcp_config.json`; skills
  (`.agents/skills/`, `~/.gemini/config/skills/`); AGENTS.md + `.agents/rules/`; note
  `~/.gemini/GEMINI.md` is shared with Gemini CLI (collision risk, gemini-cli#16058).
- Risk: fast-churning config (`serverUrl` rename, `.agent/`→`.agents/`), preview-grade
  enterprise governance, VS Code fork (Open VSX extensions work).
- Docs: antigravity.google/docs/{hooks,mcp,skills,rules-workflows}.

### opencode
- Capture: **JS plugin** (its hooks are code, not commands): global
  `~/.config/opencode/plugins/*.ts` or project `.opencode/plugins/`, or npm package via
  `"plugin": [...]` in `opencode.json` (auto-installed by Bun). Plugin receives
  `{ project, client, $, directory, worktree }`; event bus has `session.idle`,
  `message.updated`, `session.error`, etc.; full transcript via
  `client.session.messages({ path })`; unrestricted network access.
- Storage: `~/.local/share/opencode/project/<slug>/storage/` (one JSON per message part);
  internal/unstable — prefer plugin/SDK. `opencode serve` exposes SSE `/event` (all sessions)
  + `GET /session/:id/message`.
- Serve: MCP local/remote with OAuth + dynamic client registration; custom tools
  (`.opencode/tools/`); skills (reads `.claude/skills` and `.agents/skills` too); AGENTS.md
  (+ CLAUDE.md fallback); `"instructions"` array accepts **remote URLs**.
- Watch: very high release cadence; weak project-trust model (repo `.opencode/` auto-activates);
  pin `@opencode-ai/plugin` versions.
- Docs: opencode.ai/docs/{plugins,mcp-servers,skills,rules,server,sdk}.

### claude.ai / Claude Cowork (consumer)
- Passive capture: none for individuals. Manual export (Settings → Privacy, emailed link).
  **Compliance API is Enterprise-plan only** (chats/files/projects retrieval; Team plan does
  NOT get it). Cowork desktop local sessions land in
  `~/Library/Application Support/Claude/local-agent-mode-sessions/` in Claude Code JSONL format
  (undocumented/community-verified; cloud sessions absent).
- Connectors see only tool name + model-authored arguments + OAuth identity. No conversation
  context, no webhooks. → courier capture only.
- Serve: custom remote MCP connectors on **all plans including Free** (Settings → Connectors →
  URL; OAuth 2.1 + DCR). Skills uploadable as ZIP (all plans; also usable in Cowork).
  Connectors added on claude.ai auto-appear in Claude Code.
- Projects: no project identifier reaches a connector — binding must be explicit (per-project
  connector instance or model-passed label).
- ToS prohibits automated access/scraping of claude.ai (enforced 2026); local Claude Code
  transcript export via hooks is a sanctioned surface.

### ChatGPT (consumer)
- Desktop app (Jul 2026 redesign): ChatGPT ↔ Codex global switcher; ChatGPT side has **Chat
  and Work modes**. The Codex view is local Codex — full hook capture via the normal Codex
  atoms (see Codex section). Chat/Work modes: no documented hook surface → courier only.
- Passive capture (ChatGPT conversations): none. Manual export = Free/Plus/Pro only (not
  Business/Enterprise!).
  **Compliance API (`api.chatgpt.com/v1/compliance`) = Enterprise/Edu workspaces only.**
- Apps/connectors see tool-call args + `_meta` locale/userAgent/userLocation only; invoked-only,
  no passive context. Community reports dev-mode MCP disables ChatGPT memory in that chat.
- Serve: custom connectors need **Developer mode, Plus and above** (admins can disable);
  reviewed directory apps (Apps SDK, MCP-based) are the one-tap path. No localhost — server
  must be public HTTPS.
- ChatGPT Projects identity not exposed to connectors.
- Codex cloud tasks: no transcript API; `codex cloud` CLI + GitHub Action `output-file` can
  capture; tasks surface as PRs.

## 4. Potpie pattern (verified locally + repo)

What they do: `uv tool install potpie && potpie setup` → global skills in `~/.claude/skills/`
(8 skills + `agents/openai.yaml` multi-harness adapters), a marker-delimited managed block in
`~/.claude/CLAUDE.md`, version manifest + drift detection (`potpie doctor`). Skills instruct
the agent to **shell out to the `potpie` CLI** (local daemon behind it); MCP is an explicit
fallback. Project identity resolved at call time: `~/.potpie/pots.json` maps working-tree paths
and normalized git remotes → pots. **No passive capture at all** — memory writes happen only
when the model remembers to run `potpie record`; optional hooks exist but only call a
deterministic, model-free `graph nudge`.

Copy: idempotent one-command setup with `--dry-run`; managed marker blocks; versioned
skills + drift detection; central repo→project mapping (repos stay clean).
Exploit: passive hook capture is exactly what they lack — sessions that end abruptly capture
nothing. Their silent fallback to the "active pot" for unregistered repos causes cross-project
bleed — we resolve at setup time instead (§6).

## 5. What Flow ships: four atoms + one materializer

Not per-tool bundles. The repo ships four artifacts; the installer renders them per tool.

1. **The hook shim** (`~/.flow/bin/flow-hook`) — one Node script, zero deps, versioned. Reads
   hook JSON from stdin, normalizes the harness dialect (`--harness` flag), skips Flow-run
   sessions (`FLOW_SESSION_ID` env), reads the transcript delta from `transcript_path`
   (byte-offset watermarks in `~/.flow/watermarks.json`), redacts secrets client-side, POSTs to
   the bound deployment's ingest endpoint with the user token. Fail fast and silent
   (`--max-time`, always exit 0). The opencode variant is the same logic as a ~40-line JS plugin.
2. **The MCP registration** — no code; a config stanza pointing at the bound deployment's
   project-scoped MCP URL (`https://flow.acme.com/<project>/mcp`) + token, rendered in each
   tool's dialect.
3. **The skill** — one `SKILL.md` body copied into each tool's skills dir: orient at start,
   search on surprise, `remember` durable conclusions at end, skip for trivial edits. Doubles as
   the **courier capture** channel on surfaces without hooks (claude.ai, ChatGPT).
4. **The instruction block** — 3–4 lines, marker-delimited (`<!-- flow-start -->…<!-- flow-end -->`),
   spliced into AGENTS.md / CLAUDE.md / GEMINI.md / copilot-instructions.md. The always-on
   breadcrumb that makes the model reach for the on-demand skill.
5. **The materializer** (in the orchestrator; also runs as one-shot `npx @flow/connect`) —
   knows every tool's paths and dialects, renders atoms 1–4 with instance URL + per-user token,
   writes idempotently (JSON-merge / marker-splice), records versions in
   `~/.flow/integrations.json`, repairs drift, uninstalls cleanly.

Per-tool rendering:

| Tool | Files written | Atoms |
|---|---|---|
| Claude Code | `.claude/settings.json` hooks → shim; `.mcp.json`; `.claude/skills/flow/` | 1,2,3,4 |
| VS Code + Copilot CLI | `.github/hooks/flow.json`; separate `.github/mcp.json` and `.vscode/mcp.json`; `.github/skills/flow`; instructions block | 1,2,3,4 |
| Codex | `.codex/hooks.json` + `[features] hooks`; `config.toml` MCP; `.agents/skills/flow/`; AGENTS.md block | 1,2,3,4 |
| Cursor | `.cursor/hooks.json` (`"version":1`); `.cursor/mcp.json`; skill/rule | 1,2,3,4 |
| Gemini CLI | `.gemini/settings.json` (hooks + mcpServers); GEMINI.md block; skills | 1,2,3,4 |
| Antigravity | `.agents/hooks.json` / `~/.gemini/config/hooks.json`; `mcp_config.json`; skills | 1,2,3,4 |
| opencode | `.opencode/plugins/flow.ts` (shim-as-plugin); `opencode.json` MCP | 1′,2,4 (3 inherited) |
| claude.ai / ChatGPT | nothing writable — dashboard shows connector URL + skill ZIP + paste steps | 2,3 (manual) |

## 6. Distribution & install model (decisions)

- **No marketplaces.** Decisive reason: Flow deployments are **self-hosted** (user's own EC2 or
  localhost). Marketplace bundles are static/generic; every Flow artifact must embed *that
  instance's* URL and a per-user token. Distribution comes from each instance itself.
  (Marketplaces/directories remain relevant only for claude.ai/ChatGPT connector listing, later.)
- **Something of Flow's is always installed** at install time (CLI now, Mac app later) — it is
  the hand that writes files. No resident process is required for capture afterward.
- **`flow connect <url>`** — binds **machine → deployment** only (auth; named remote in
  `~/.flow/config.json`; multiple remotes coexist: implicit `local` + team EC2s). Never selects
  a project.
- **`flow setup`** (run in a repo) — binds **folder → (deployment, project)** explicitly, once:
  1. Normalize git remote + path; query all connected remotes' source registries.
  2. Exactly one match → auto-bind (the common case; zero questions). Multiple → prompt once,
     stored per (user, machine, path) — the existing `work_folders` shape. None → prompt: link
     as work folder to an existing project (BRAIN/WORK split: independent of indexing), also
     register as source, or create a project.
  3. Materialize atoms into the repo's own config dirs (per-folder activation enforced by the
     harnesses natively). Result is **baked in**: `flow-hook --project <p>`, project-scoped MCP
     URL. Nothing resolved at capture time (avoids Potpie's silent-fallback bleed).
  4. Default **personal mode**: all written paths appended to `.git/info/exclude` — repo history
     never touched. `flow setup --share` un-excludes so a team can commit them (covers
     teammates + vendor cloud agents).
  5. Idempotent re-runs; new worktrees/clones re-run `flow setup` and get the zero-question path.
- Residual per-tool friction (unavoidable, one-time, per repo): Claude Code project-MCP
  approval, Codex `/hooks` trust, Cursor/VS Code MCP confirm. `flow setup` output lists what
  to expect.
- Dashboard Connections page (per deployment, since each dashboard is authoritative for its own
  projects): **Automatic** (connect command / Mac app + per-repo status), **Manual** (rendered
  copy-paste snippets per tool with URL+token substituted), **Cloud apps** (connector URL +
  skill ZIP + instructions).

## 7. Runtime architecture (decisions)

**Two-binding model, git-remote style**: machine→deployment (`flow connect`),
folder→(deployment, project) (`flow setup`). One Flow stack, N deployments (localhost:7600 for
local projects, prod URL for prod). Each deployment's dashboard is authoritative for its own
projects; localhost:7600 stays as-is; no aggregation/proxying (local dashboard gets a
lightweight Remotes list; the future Mac app is the eventual aggregator as a client of N
deployments).

**Local control plane, remote brain** (no relay, no added latency):

```
                    YOUR LAPTOP                                      EC2 (flow.acme.com)
┌──────────────────────────────────────────────────┐      ┌──────────────────────────────────┐
│   Browser: flow.acme.com/<project>/agents        │      │   Dashboard (serves the UI)  ──① │
│  ┌────────────────────────────────────────────┐  │      │                                  │
│  │  /agents page                              │◄─┼──①───┤   ┌──────────────────────────┐   │
│  └───────┬────────────────────────────────────┘  │      │   │  THE BRAIN (per project) │   │
│          ② browser → localhost:7600              │      │   │  graph · memory ·        │   │
│          │ create/prompt/stream/steer/approve    │      │   │  distiller · sources ·   │   │
│          ▼         (zero internet hops)          │      │   │  session mirror          │   │
│  ┌────────────────────────────────────────────┐  │      │   └─────▲──────────▲─────────┘   │
│  │  Local orchestrator (localhost:7600)       │──┼──③ MCP (orient/search/remember)─┘       │
│  │  ACP runtime spawns claude/codex/opencode  │──┼──④ async transcript upload──────┘       │
│  │  in the work folder                        │  │                                          │
│  └────────────────────────────────────────────┘  │                                          │
└──────────────────────────────────────────────────┘                                          
```

- ① page load only. ② all interactivity, browser→localhost direct — identical ACP experience
  to local. ③ brain queries between agent turns. ④ async, buffered, retried; feeds distiller +
  read-only teammate mirror.
- The local case is the same diagram folded (①–④ all localhost). Hand-driven Cursor/Claude
  Code sessions skip ② entirely — their hooks are ④ and their MCP config is ③.
- Requirements: CORS + Chrome Private Network Access preflight
  (`Access-Control-Allow-Private-Network: true`) on the local orchestrator, origin-allowlisted
  to connected deployments; **mandatory machine-scoped pairing token** on every localhost call
  (else any webpage could drive local agents); graceful-absence UX. Open checkpoint: Safari's
  handling of `http://localhost` from HTTPS pages.
- **Future "run on EC2" toggle**: symmetric — browser talks to flow.acme.com directly
  (its own localhost case); server-side managed worktrees from sources (the "agents only on
  local work folders" rule is amended by giving EC2 its own work surface, sources stay
  pristine); headless API-key auth for harness CLIs; delivery via branch/PR.
- Outbound-WebSocket relay: demoted to an optional future add-on solely for phone/teammate
  remote-driving. Never in the latency path.

## 8. Build list (dependency order)

1. Ingest endpoint on the orchestrator (`POST /v1/ingest/transcripts` + lifecycle events),
   auth by user token; per-external-session watermark (mirrors `last_distilled_seq`);
   harness-dialect → `SlimEvent` adapters (version-tolerant).
2. Atom 1 (shim) + atom 5 (materializer) with the first three tools: Claude Code, Cursor,
   Codex. VS Code/Copilot CLI ride the Claude files.
3. `flow connect` remotes + `flow setup` resolution flow (+ `.git/info/exclude` handling,
   `--share`, `--remove`).
4. ACP runtime honors folder bindings: mount bound deployment's MCP; ship transcripts to bound
   deployment's ingest (today both are hardcoded local).
5. Dashboard Connections page (three tabs) + per-repo status from manifests/ingest.
6. Browser→localhost path for the prod /agents page (CORS/PNA + pairing token + Safari spike).
7. Skill + instruction block content; claude.ai/ChatGPT connector serving (remote MCP on the
   gateway) + courier capture.
8. Later: EC2-side runner (managed worktrees, headless auth, PR delivery); optional relay for
   remote driving; enterprise registry/allowlist listings.

## 9. Cross-cutting cautions

- Transcript formats are unstable **by vendor statement** (Claude Code, Codex) and by observed
  churn (Cursor stores, opencode storage, VS Code chatSessions JSON→JSONL). Prefer hook payload
  fields; parse files defensively; version-check via payload fields where offered.
- Hooks are Preview-tier at Microsoft, young at Google (Jan 2026), churning at Cursor. Fail
  open; never block a user's session; hook shims must exit 0 on any error.
- Enterprise admins can block everything (MCP allowlists/registries at GitHub/VS Code/Cursor;
  managed settings at Anthropic; Developer-mode disable at OpenAI; system settings at Google).
  Enterprise path = get Flow onto the org's internal allowlist/registry.
- Codex re-trusts hooks on definition change — never change the hook line, only the versioned
  script behind it.
- Secrets: redact client-side in the shim before upload (transcripts contain raw tool output).
- Competitive: GitHub Copilot "chronicle" already cloud-syncs sessions and answers questions
  over them. Flow's moat: cross-tool coverage + distilled durable memory + self-hosted brain,
  not raw recall.


## Headless validation notes (2026-09-06)

In Gemini CLI 0.54.0, headless runs may omit tools that require interactive
approval even when `gemini mcp list` says connected and `gemini skills list`
says enabled. The following limited permission test activates the Flow skill
and calls native MCP against both local and remote project bindings:

```sh
gemini --skip-trust --policy /path/to/flow/docs/examples/gemini-flow-orient-policy.toml \
  --output-format stream-json \
  -p 'Activate the Flow skill, then call Flow orient. Do not edit files or delegate.'
```

`--skip-trust` applies only to the known test fixture for this invocation.
The supplied Policy Engine file permits skill activation and only Flow orient
among MCP tools; this replacement for deprecated `--allowed-tools` passed a
real cloud session. Interactive users can approve tools normally. Do not globally disable file
ignore filtering to work around a direct read of a personally installed skill:
`activate_skill` loads the ignored skill correctly once permitted.

Codex may defer MCP tools. Generated instructions now require discovery before
falling back to the shell CLI, whose network access may be sandboxed. Native
MCP orientation has passed against the HTTPS test deployment with an ordinary
orientation prompt. PATH CLI 0.136.0 required an explicitly compatible gpt-5.5 model
in this test environment; the user's global model was unchanged.

### Executable discovery after updates

Dashboard updates restart services without sourcing shell startup files. Setup
and the agent runtime share executable discovery: use the current PATH first,
then a previously discovered absolute path, then standard user/system installer
locations (including `~/.opencode/bin`, `~/.local/bin`, Homebrew, Bun, and NVM).
Setup and runtime discoveries are saved per OS user in
`~/.flow/executables/<command>.json`; missing or non-executable saved paths are
ignored and rediscovered. A custom location can be learned by running setup with
that directory on PATH. Runtime selection still excludes Flow-managed bundled
executables and retains its version ranking.

After starting services, `flow up` probes the selected backend with `--version`
and warns if the executable cannot run. This checks executable availability;
authentication and model access are separate checks.

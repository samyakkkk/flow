# Flow overnight work: instructions and progress

Authoritative continuation document. Update after meaningful changes, tests or blockers. Installation, hook receipt and scheduled continuation are not end-to-end success.

## User instructions, in priority order

1. Create an isolated worktree and local Flow alias, preserving main/prod. Exercise `flow setup <project>` with real Gemini, Codex and Claude CLI sessions, Cursor and Antigravity desktop, and VS Code Copilot. Verify Flow instructions, skills, MCP and CLI fallback. Deploy Flow to a new Hetzner server and repeat against cloud Flow. Configure/test OpenCode using the supplied OpenRouter key. Fix discovered failures.
2. Implement permission-aware remote source read/search for repositories present in the cloud graph but absent locally. Example: ten graph repos, five local clones. Agents need actual source verification for the other five with repository/revision identity and access checks, not unusable cloud paths.
3. Identify the existing coding-agent PR, merge as authorized and test it. Test Slack/automation triggers, worktree lifecycle and performance. Simple questions should answer quickly without creating worktrees; code changes should use appropriate isolated worktrees. Existing PR identity is unresolved; do not guess. Our new PR #79 is separate.
4. LAST: verify hooks all the way through memory extraction and retrieval. Run real sessions with unique non-sensitive durable facts. Verify hook invocation, authenticated ingestion, persisted transcript/session, successful extraction, stored memory and retrieval in a fresh session. Cover applicable CLI/desktop integrations on local and cloud Flow. Record backend/session IDs, extraction state, retrieval evidence and latency. Hook execution or an ingestion row alone does not pass. Distinguish unsupported hooks from broken integrations and fix feasible gaps.

User requested sustained overnight work (roughly 7–8 hours), milestone commits and a PR. Continue useful work independently and report real blockers; do not claim flawless completion without evidence. Easier workspace/device connection UX is secondary. Shared credentials must not implicitly authorize execution on arbitrary teammates’ devices or exposure of their sensitive files. User confirmed Claude authentication. Requested Antigravity UI demonstration was completed: read Flow skill and called native orient without editing files.

## Keys and authorization

User authorized provisioning new Hetzner test servers and supplied Hetzner and OpenRouter keys. Raw keys are deliberately outside Git; this document records how to find them. Private directory `~/.config/flow-validation/` is mode 0700, credential files mode 0600:

| File | Purpose |
| --- | --- |
| `hetzner-token` | Supplied Hetzner API token for test infrastructure |
| `openrouter-key` | Supplied OpenRouter key for Flow/OpenCode |
| `hetzner-ed25519` | Dedicated SSH private key |
| `known_hosts` | Pinned server SSH identity |
| `cloud-credentials.json` | Generated cloud owner credentials and Flow personal token |
| `server.json` | Provisioned resource metadata |

Load credentials directly into required process environment/config. Never echo them, commit them, include them in reports or send them to Flow memory. Machine Flow config also contains private tokens. Bootstrap logs may contain secrets; inspect selectively.

## Environment

- Worktree: `/Users/samyakjain/Documents/flow-workspace/flow-cloud-harness-validation`.
- Branch `codex/cloud-harness-validation`, based on `origin/main-dev` 49554e3.
- Draft PR: https://github.com/samyakkkk/flow/pull/79.
- Node: `/Users/samyakjain/.nvm/versions/node/v22.22.3/bin/node`.
- Local alias `flow-cloud-test`, project `harness-lab`, gateway 19433, orchestrator 19500, dashboard 19600, independent FalkorDB 18379.
- Fixtures: `data/harness-fixture` (local), `data/cloud-fixture` (cloud client), each independent Git repo.
- Integration backup: `~/.flow/backups/cloud-harness-validation`.
- Hetzner server 164708090, `flow-harness-validation`, IPv4 5.223.65.87, cpx32 4 CPU/8 GB Singapore, approximately EUR 0.0929/hour plus IPv4. Existing `flow-test` untouched. SSH restricted to developer IP; public 80/443.
- Cloud `/opt/flow`, alias `flow-cloud-test`, offset 1000, project `harness-cloud`. Gateway 8433, orchestrator 8500, dashboard 8600, FalkorDB 7379. Ubuntu 24.04, Node 22.22.3, Docker, Caddy, 4 GB swap. Last verified cloud commit c1f99a7; sync newer changes.
- HTTPS https://5-223-65-87.sslip.io; connector prefixes `/harness-cloud/gateway` and `/harness-cloud/orchestrator`. Caddy exposes limited connector routes; ordinary dashboard routes use prod auth.
- Private provisioning/bootstrap scripts and git bundle in `~/.config/flow-validation/`. Remote `/root/flow-up.log` can contain secrets.
- Heartbeat `flow-cloud-setup-overnight` continues every 30 minutes. Notify meaningful changes or required user actions; pause on completion.
- Raw test logs in ignored `data/`; commit sanitized evidence only.
- Use Flow skill/MCP orient at start and after compaction. MCP orient works; semantic search/memory and original-checkout CLI previously returned 401. Do not infer empty memory from errors.

## Completed implementation

- 1a50d80: pin installation Node in alias, set child PATH, open SQLite during preflight; fixes runtime/ABI mismatch.
- af77335: authenticated stateless HTTP MCP, project graph pinning, Origin boundary, bounded requests and session-only tools.
- 6b595bd: authenticated remote discovery/setup and stdio-to-HTTP bridge; remote clients need no local Flow gateway/database.
- c1f99a7: shared PAT verification; personal tokens restricted to knowledge/capture, excluding execution/admin; matching project discovery. Codex SessionEnd timeout reduced to three seconds.
- 486601c: adding a harness retains existing integrations.
- Twelve materializer/remote-setup tests and connector auth tests passed. Gateway typecheck passed. Orchestrator whole-project tsc has errors: establish baseline before claiming unrelated; no typecheck npm script there.
- `scripts/check-remote-mcp.mjs <project>` and `scripts/check-remote-setup.mjs <project>` pass for `harness-lab` and real HTTPS `harness-cloud`, including fresh HOME, private credentials, bridge orientation and rejected unauthorized/cross-project requests.

## Integration evidence and remaining work

| Client | Local | Cloud / gap |
| --- | --- | --- |
| Claude | Native MCP passes after auth; `data/claude-local-authenticated.jsonl` | `data/claude-cloud.jsonl` confirms skill activation, ToolSearch and native MCP orient |
| Codex | Native MCP passes with explicit gpt-5.5; `data/codex-local-compatible.jsonl` | Native MCP now passes; ordinary prompt retest in `data/codex-cloud-instructions.jsonl` passes after discovery instruction fix |
| Gemini | CLI fallback passes; ignored skill file read refused; native MCP absent | Same partial outcome in `data/gemini-cloud.jsonl`; full support not passed |
| Antigravity | Desktop reads skill and native orient succeeds; conversation “Repository Flow Orientation Guide” | Cloud desktop and capture pending |
| VS Code Copilot | Desktop skill and native orient pass, about 17 seconds | Cloud desktop and capture pending |
| Cursor | Launched into existing chat; fixture prompt not submitted | Local/cloud tests pending |
| OpenCode | Local test pending | OpenRouter-backed session activates skill and calls native MCP; `data/opencode-cloud.jsonl` |

Installed Codex CLI 0.153.4 rejected configured gpt-6-astra; explicit gpt-5.5 worked. Do not globally change user model. `--ignore-user-config` suppressed project MCP, so that mode is not representative. Direct cloud bridge smoke passes despite Codex cloud session failing to use it.

Local ingestion DB `data/projects/harness-lab/flow.db` previously had three Claude and two Gemini external sessions, no Codex. Antigravity/Copilot capture unverified. No complete hook-to-extracted-memory verification has passed yet.

## Update log

- 2026-09-06: Consolidated all task instructions and current evidence here, replacing the stale checkpoint. Added hook-to-memory verification as the final task, with extraction and subsequent retrieval required. Stored supplied OpenRouter key privately. Main integrations, remote source access and automation work remain in progress.

- 2026-09-06: Codex cloud transport confirmed healthy; original failure was premature CLI fallback. Generated skill and instructions now require deferred MCP discovery before fallback. Ordinary-prompt retest passes; 12 setup/materializer tests pass. Claude cloud native skill/MCP evidence confirmed. OpenCode 1.17.20 with OpenRouter Claude Sonnet 4.6 activated Flow skill and called cloud native orient. Key placed in isolated local/cloud project .env (0600); cloud OpenCode installation underway. Gemini lists Flow connected and skill enabled, but headless tools remain missing; explicit-tool-permission test pending. No hook-to-memory completion claimed.

# Flow overnight work: instructions and progress

Authoritative continuation document. Update after meaningful changes, tests or blockers. Installation, hook receipt and scheduled continuation are not end-to-end success.

## User instructions, in priority order

1. Create an isolated worktree and local Flow alias, preserving main/prod. Exercise `flow setup <project>` with real Gemini, Codex and Claude CLI sessions, Cursor and Antigravity desktop, and VS Code Copilot. Verify Flow instructions, skills, MCP and CLI fallback. Deploy Flow to a new Hetzner server and repeat against cloud Flow. Configure/test OpenCode using the supplied OpenRouter key. Fix discovered failures.
2. Implement permission-aware remote source read/search for repositories present in the cloud graph but absent locally. Example: ten graph repos, five local clones. Agents need actual source verification for the other five with repository/revision identity and access checks, not unusable cloud paths.
3. Identify the existing coding-agent PR, merge as authorized and test it. Test Slack/automation triggers, worktree lifecycle and performance. Simple questions should answer quickly without creating worktrees; code changes should use appropriate isolated worktrees. Matching PR #74 (Add OpenCode cloud conversations with lazy worktrees) was already merged at 5ae5da0 and is included in this branch; no further merge needed. Our PR #79 is separate.
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
- Cloud `/opt/flow`, alias `flow-cloud-test`, offset 1000, project `harness-cloud`. Gateway 8433, orchestrator 8500, dashboard 8600, FalkorDB 7379. Ubuntu 24.04, Node 22.22.3, Docker, Caddy, 4 GB swap. Cloud synchronized through 5f494d0; OpenCode 1.17.20 installed.
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
| Gemini | Skill activation and native orient pass with explicit headless tool permission; `data/gemini-local-skill.jsonl` | Same passes in `data/gemini-cloud-skill.jsonl`; normal interactive permission flow still to verify |
| Antigravity | Desktop reads skill and native orient succeeds; conversation “Repository Flow Orientation Guide” | Cloud desktop and capture pending |
| VS Code Copilot | Desktop skill and native orient pass, about 17 seconds | Cloud desktop and capture pending |
| Cursor | Skill and native orient passed after enabling workspace MCP; “Installed FlowSkill orientation,” about 13 seconds | Cloud test pending |
| OpenCode | Skill and native orient passed; `data/opencode-local.jsonl` | OpenRouter-backed session activates skill and calls native MCP; `data/opencode-cloud.jsonl` |

The PATH-selected Codex CLI 0.136.0 rejected configured gpt-6-astra; explicit gpt-5.5 worked. Do not globally change user model. `--ignore-user-config` suppressed project MCP, so that mode is not representative. Direct cloud bridge smoke passes despite Codex cloud session failing to use it.

Local ingestion DB `data/projects/harness-lab/flow.db` previously had three Claude and two Gemini external sessions, no Codex. Antigravity/Copilot capture unverified. Gemini cloud → stored memory → fresh Claude retrieval has since passed; see the dated log below. Other integrations remain partially verified.

## Update log

- 2026-09-06: Consolidated all task instructions and current evidence here, replacing the stale checkpoint. Added hook-to-memory verification as the final task, with extraction and subsequent retrieval required. Stored supplied OpenRouter key privately. Main integrations, remote source access and automation work remain in progress.

- 2026-09-06: Codex cloud transport confirmed healthy; original failure was premature CLI fallback. Generated skill and instructions now require deferred MCP discovery before fallback. Ordinary-prompt retest passes; 12 setup/materializer tests pass. Claude cloud native skill/MCP evidence confirmed. OpenCode 1.17.20 with OpenRouter Claude Sonnet 4.6 activated Flow skill and called cloud native orient. Key placed in isolated local/cloud project .env (0600); cloud OpenCode installation underway. Gemini lists Flow connected and skill enabled, but headless tools remain missing; explicit-tool-permission test pending. No hook-to-memory completion claimed.

- 2026-09-06: Gemini headless omission traced to tool permissions; explicitly permitting activate_skill and mcp_flow-graph_orient succeeds, including loading the personally installed ignored skill. Documented invocation in docs/harness-integrations.md; no ignore-filter weakening. Hetzner synchronized through 7d26843, OpenCode 1.17.20 installed, fresh server-fixture configured with flow setup; /root/opencode-server.jsonl shows native orient completed. Cursor workspace picker interactions are flaky via AX; continue with fresh UI observations.

- 2026-09-06: User confirmed intended split: only Flow/OpenCode on server, external coding clients on Mac. Fresh OpenCode-only setup revealed missing shared skill/AGENTS instructions (also Gemini/Antigravity-only). Fixed renderers to install independently of Codex; removal now restores pre-existing owned files for all harnesses, not only Copilot. All 15 materializer/remote-setup tests pass. Cursor desktop read the skill but native MCP was absent; one-time CLI orient permitted, result pending.

- 2026-09-06: User requested a future info option beside each coding agent explaining required permissions/setup quirks. Capture confirmed behavior, recovery steps and unresolved items in docs/coding-agent-setup-notes.md. Implementing that UI is a follow-up requirement; keep this document current as tests finish. Cursor server was Disabled in Customize; enabling the fixture source changed it to Connected/eight tools. Native retest pending. OpenCode local and server skill/native-MCP retests passed.

- 2026-09-06: Cursor native MCP retest passed in desktop conversation “Installed FlowSkill orientation,” about 13 seconds, after enabling its installed workspace server. Updated per-agent setup notes. Antigravity cloud project creation underway (native folder picker).

- 2026-09-06: Mac locked; automatic unlock failed, so remaining desktop interactions deferred. Started priority 2 while blocked on UI. Implemented project-scoped source_read/source_search over registered Git repositories, indexed SHA default with revision labels, bounded output, no dirty/untracked reads or symlink following. sourceRead:false excludes a repo; no per-user intra-project ACL is claimed. All 25 gateway tests and 15 setup tests pass; gateway tsc passes. docs/remote-source-access.md details behavior. Live Hetzner-only source verification is next.

- 2026-09-06: Live remote source smoke passed via personal-token HTTPS (scripts/check-remote-source.mjs harness-cloud). Synthetic remote-only-fixture exists only on Hetzner; indexed commit 1ccce76f1148d73882ccb6ad58a59822aa9d7d23 contains refundWindowDays=17 while dirty working copy contains 99. Codex independently searched/read and cited value17, exact SHA and line2 without cloning; data/codex-remote-source.jsonl. Cloud auth/remote fresh-home smoke still pass.
- 2026-09-06: All 354 orchestrator tests passed, including real OpenCode plugin smoke. PR74 already merged/included. Live task API on Hetzner: question b00af38c-a65c-4f2b-9f21-0848618cb914 returned retryLimit3 and zero worktrees; edit c8d073bc-1e7a-4fd2-9aa9-4340564c99a4 created one tree worktrees/task-fixture/cloud-task-vs8z with retryLimit5 while source remains3. Follow-up697078aa-5f7d-45aa-81ad-63a556a5b259 returned5 and reused session ses_f8cbd3ab9ffe4YfkJlkiiITXgA (all three jobs). Follow-up took37.03s: functionality passes, speed still needs work. Private /root/flow-task-validation.json records conversation/job IDs. Slack test channel question pending; no live Slack message sent.
- 2026-09-06: Hook-to-memory pipeline tested without direct memory writes. Gemini cloud session551127a4-5f16-40e3-b46c-b041823949cd closed, transcript watermark3, observation/session link, stored Cedar29-minute fact (memory2a6873e9-28d3-4061-b5de-ca0e1056d49a). Fresh Claude session5534faeb-bad4-4b53-8625-962e7953152c retrieved29-minute rule and reason from Flow, no local transcript reads. Logs data/gemini-hook-memory-cloud.jsonl and data/claude-memory-retrieval-cloud.jsonl. Claude Atlas test captured but model extracted[]; not claimed as memory pass. Local capture now includes Claude, Gemini, Cursor, Copilot, OpenCode; Codex absent, Antigravity absent.
- 2026-09-06: Fixed a discovered distillation retry bug: provider failure returned ran:false but trigger advanced watermark. Failed extraction now remains eligible for retry; 85 memory tests pass including regression. Codex hooks/list reports project SessionStart/UserPromptSubmit/Stop enabled/untrusted; invocation bypass flag still yields no captured session. Diagnostic in progress: fixture .codex/hooks.json temporarily has an extra keys-only logger; original saved data/codex-hooks-original.json, script .codex/flow-hook-diagnostic.py. Restore original and remove diagnostic files after test92593 completes. No secrets logged. Manual cached under /private/var/folders/mc/2d3wf4h14bx4rlgd2mb6qyw80000gn/T/openai-docs-cache/codex-manual.md.

- 2026-09-06 CORRECTION: plain codex resolves /opt/homebrew/bin/codex 0.136.0, whereas NVM Node22 bin/codex and app bundle are 0.153.4. Earlier plain-codex compatibility/headless claims belong to0.136, not0.153.4. Old headless exec produced no hook events; old interactive TUI did. Explicit NVM0.153.4 headless exec fired SessionStart/UserPromptSubmit/Stop and produced closed captured ext-codex-01a07348-aa02-73c2-bdb3-acf992fff108. Diagnostic config/files restored/removed. Fresh current-version memory test running (13670) with configured default model; data/codex-current-hook-memory-local.jsonl. Info UI must show actual selected executable path and version, not merely installed/latest version.

- 2026-09-06: Updated future per-agent info notes with selected Codex executable/version, independently trusted hooks, confirmed Gemini-to-Claude memory round trip, and idle extraction timing. Current Codex0.153.4 default-model test completed with closed capture; extractor returned[] (capture pass, no retained-memory claim). Added remote source read/search to cloud job tool allowlist; project gateway authorization still governs source access.

- 2026-09-06: Hetzner test deployment synchronized through5f494d0 and restarted successfully using /usr/local/bin/flow-cloud-test. Post-restart HTTPS source and authenticated MCP boundary smoke checks passed. Cloud policy19 tests passed. Flow remember dispatch returned401; the requested setup quirks remain durably committed in docs/coding-agent-setup-notes.md and this log.

- 2026-09-06 heartbeat: Antigravity remains readable through the existing CDP session even while native desktop interaction is unavailable. Saved data/antigravity-cloud-result.txt: cloud conversation completed but named harness-fixture and stopped on presumed mismatch. On-disk cloud MCP config correctly passes harness-cloud/cloud-fixture; actual cached connection still needs verification. Gateway orient previously labelled repo only, so added explicit server-owned CONNECTED PROJECT and local shim project env plus skill guidance separating repo/project. Regression rejects caller identity spoofing and labels missing server identity unavailable; gateway26 tests pass. Cloud task log breakdown: initial question15.088s, edit19.151s, follow-up36.418s; follow-up first tool event only ~2.9s before completion, so most latency precedes first tool rather than worktree creation.

- 2026-09-06: Deployed06cae53 to Hetzner; authenticated MCP smoke passes after restart. Gateway26 tests/typecheck and materializer13 tests pass. Reran remote Antigravity setup with saved private config credentials (no credential output). Plain setup harness-cloud without remote flags fails local project lookup; remote reconnect ergonomics need follow-up. Antigravity same-conversation retest still saw old header; fresh conversation Execute Flow Skill Orientation also used old native response then requested CLI fallback approval after sandbox EPERM. Approval granted once, result pending. PR79 body/title now reflects current implementation, evidence and remaining gaps; stays draft.

- 2026-09-06: Antigravity fresh conversation Execute Flow Skill Orientation completed cloud CLI fallback after one-time command approval. It quoted CONNECTED PROJECT: "harness-cloud" and repo "cloud-fixture" @main correctly. Cloud fallback is verified; native MCP still appears stale and is not a pass.

- 2026-09-06 heartbeat: Implemented plain flow setup <project> reconnect for saved remote projects. Revalidates gateway/capture identity before mutation, retains explicit registered repo name, and keeps existing harnesses. Partial explicit remote flags still reject; no guessing another project.16 setup/materializer tests and fresh-HOME live HTTPS reconnect/stdio/CLI smoke pass. Added mismatch/no-mutation smoke assertion for final verification. Process ownership confirms Antigravity language_server PID1573 has only harness-lab MCP child12991; VSCode owns cloud connector39365. This confirms Antigravity cloud native was using its earlier local process, not cloud gateway failure. Remaining app connection refresh test deferred; no unrelated user processes changed.

- 2026-09-06: Full orchestrator suite passes358 tests, including real OpenCode plugin smoke and newly wired remote setup tests. Remote reconnect smoke also confirms mismatched project rejection without changing MCP files or repo binding. Performance root lead: OpenCode logs show28s background dependency install failure (Unsupported engine) in workspace/.opencode before provider stream. That directory lacked package.json, and npm prefix resolved ancestor /opt/flow. Testing an isolated pinned @opencode-ai/plugin manifest there; temporary cloud manifest currently installed for latency experiment.

- 2026-09-06: Performance fix verified: isolated workspace/.opencode/package.json with pinned @opencode-ai/plugin1.17.20 and one dependency install removed repeated background install failure. Follow-up0ed430c6-c33d-4287-803a-1b3420f817dc returned5 in8.636s using the original session/worktree (previous36.418s). Fresh question14b8c483-f396-4c62-b761-a4a1d68086f6 returned shared-source3 in13.662s, new session but total worktree count still1 from the previous edit. No recent install failure in log. Added manifest to index-workspace template and standalone OpenCode materializer (create only if absent, preserve existing user manifest, remove only Flow-owned manifest).14 materializer tests pass including idempotence/ownership regression. These timings are samples; further speed tuning and desktop/native hook work remain.

- 2026-09-06 heartbeat: Mac remains locked; native VSCode/Cursor checks unavailable. Antigravity bundled docs prove PostInvocation/Stop require flat handler lists (old Flow renderer incorrectly grouped them). Fixed format, explicit --event identity, bounded client-side latest USER_INPUT/visible PLANNER_RESPONSE extraction, redaction and normalized prompt+answer.38 hook/ingest/materializer tests pass; additional normalization assertion passes. Deployed3dcad32 and reran cloud fixture setup. Real Antigravity conversation Juniper Validation Bundle Rule, session4622bee2-ed6c-4235-b5d4-a991d34bcd4e, is captured on cloud with prompt/answer:31-minute retry records for delayed mobile reconnects. Sessionidle, 757-byte transcript; waiting natural45-minute idle sweep for extraction, no direct remember calls. Antigravity docs recommend MCP in project plugins; testing fixture-only .agents/plugins/flow/{plugin.json,mcp_config.json} with nameflow-harness-cloud to resolve shared/stale MCP process. Fresh plugin orientation test is in progress; remove or materialize those files based on result.

- 2026-09-06: Full orchestrator suite passes361 tests after Antigravity changes. Real Antigravity cloud transcript includes Juniper31-minute rule and rationale; extraction awaits natural idle threshold. Project-scoped MCP plugin experiment did not launch a cloud process (still local child12991); denied that stale tool call and removed the two experimental .agents/plugins/flow files. No permanent plugin changes. Native cloud remains unresolved, cloud CLI fallback verified. Started real Claude local Willow43-minute durable-rule session with tools disabled (hooks enabled), data/claude-willow-memory-local.jsonl; check extraction and fresh retrieval next.

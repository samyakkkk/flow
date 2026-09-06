# Coding agent setup notes for the info option

Product requirement: show an info option beside every coding agent explaining
required permissions, where to enable them, symptoms when missing, recovery,
and version-specific limitations. These observations come from isolated
local/cloud validation on 2026-09-06; they are not universal version guarantees.
This document specifies the future info option; the UI is not implemented yet.

## Per-agent permissions and quirks

| Agent | Permissions and setup | Observed symptom and recovery |
| --- | --- | --- |
| Claude Code 2.1.170 | Authenticate Claude and allow the project's Flow MCP tools. Hook capture is separate. | Revoked OAuth prevented startup; reauthentication restored local/cloud skill and native MCP. |
| Codex CLI | Trust the project to load `.codex/config.toml`; enable/trust hooks separately. Discover deferred MCP tools before shell fallback. | `--ignore-user-config` suppressed project MCP. A sandboxed shell could fail networking while native MCP worked. Check the selected executable/version before changing permissions or models. |
| Gemini CLI 0.54.0 | Headless runs require explicit skill/tool permission. Pass the scoped [Policy Engine example](examples/gemini-flow-orient-policy.toml) with `--policy`. | Connected MCP and an enabled skill did not mean tools were available to the headless session. The example allows only skill activation and Flow orient. Direct file reads of an ignored personal skill could fail while skill activation worked. Do not disable ignore filtering globally. Interactive validation now passes with separate Allow once approvals for skill activation and native orient; no global allow setting was needed. |
| Cursor desktop 3.14.27 | Enable the workspace Flow MCP source when shown as Disabled. Observed path: Customize → Configure flow-graph. | Enabling the source produced Connected/eight tools and successful native local orientation. Shell fallback separately requested one-time Run approval; Always Run was unnecessary. Cloud desktop also passes after enabling its separate fixture source and approving native orient once. A fresh chat was used after enablement. |
| Antigravity desktop | Approve the Flow MCP call when prompted; one-time approval worked. Rerun setup after updating Flow. | Shared server names reused another workspace's connection. Setup now generates `flow-graph-<binding-hash>` per project/repository. A fresh conversation alone did not fix the old connection. Native cloud orientation now passes. Shell fallback required its own command approval. |
| VS Code Copilot 1.134.0 | Trust the workspace and approve/enable its MCP server as required. Keep hook permissions distinct. | Local/cloud desktop skill and native MCP pass, and cloud capture is verified. A “Claude Code hooks available… Enable” banner appeared; its relationship to Copilot's own hooks is unresolved. Do not recommend that banner as a proven capture fix. |
| OpenCode 1.17.20 | Authenticate the model provider. Pass `--dir /absolute/project/path` for the tested headless invocation. | Cwd-only execution loaded skill text but started an instance without project MCP/plugin capture. Explicit `--dir` fixed both; Flow server jobs already use it. Standalone setup now installs the shared skill without requiring Codex. |

## Codex version and hook behavior

Shell `codex` selected `/opt/homebrew/bin/codex` 0.136.0, while the Node 22
installation and desktop bundle provided 0.153.4. Show the selected executable
path and actual version, not just the newest installed version.

The older CLI rejected the configured gpt-6-astra model; explicit gpt-5.5 worked
without a global model change. Version 0.153.4 worked with the configured default.
The older headless invocation produced no hook events, while its interactive
session captured start/prompt/stop. Version 0.153.4 headless captured SessionEnd
and passed the complete memory round trip. This does not establish a minimum
supported version. The test used a one-invocation hook-trust bypass; normal
user hook trust still needs separate enablement. Do not recommend permanent
blanket hook approval.

## Integration fixes that require setup refresh

- Antigravity lifecycle hooks PostInvocation/Stop require flat handlers, unlike
  grouped tool-event hooks. Setup now renders the correct shape. Real cloud
  prompt/answer capture and subsequent memory retrieval pass after the fix.
- OpenCode needs an isolated plugin package manifest. Without it, dependency
  installation climbed to the parent checkout and repeatedly failed with an
  engine error. Setup creates a pinned manifest only when absent and preserves
  existing user manifests. One measured follow-up fell from 36.4 to 8.6 seconds
  after dependency installation; these samples are not latency guarantees.
- GUI applications may not inherit shell Node/PATH. Generated commands now pin
  the installation runtime. Validation used Node 22.22.3 after Node 24.10
  dependency/ABI problems. Rerun setup after updating an older installation.

## Separate status evidence

Connection, skill availability, transcript capture, extraction, stored memory,
and fresh-session retrieval are independent checks. Connected MCP does not
prove that hooks captured anything. Successful extraction can validly retain
zero memories; that alone is not a broken capture integration.

| Origin integration | Complete automatic capture → stored memory → fresh retrieval |
| --- | --- |
| Claude local | Passed: Willow rule, memory `cc222589-2044-4d16-9f09-9fdaaf469077`. |
| Gemini cloud | Passed: Cedar rule, memory `2a6873e9-28d3-4061-b5de-ca0e1056d49a`. |
| Codex 0.153.4 cloud | Passed: Maple rule, memory `d6a20822-310a-4ea0-9a06-9cc8ed092837`. |
| OpenCode cloud | Passed: Oak rule, memory `168b655e-38a5-41f8-9c67-23cdff33006e`. |
| Antigravity cloud | Passed: this info-option requirement, memory `e54bf0c7-c785-4af9-b792-25835de6dfe2`. |
| Copilot cloud | Capture passed; acknowledgement prompts retained nothing. A real fixture coding/test session awaits extraction. |
| Cursor | Local/cloud skill and native MCP passed; cloud requirement captured, but extraction retained nothing. Full memory retrieval remains unproven. |

These are representative paths, not every agent/environment combination.
Fresh retrieval tests used Claude with local file/command tools disabled and
Flow memory search enabled. Origin tests did not directly write memories.
Agents without session-end events may wait for the 45-minute idle threshold,
checked every five minutes. Show pending extraction separately from failure
and from a completed extraction that retained nothing. Unreadable memory stats
must display unavailable, not an empty store; orient now distinguishes these.

## Shared info-option guidance

- Keep approvals scoped. Read-only orientation permission does not establish
  permission for writes, execution, or hook uploads.
- Explain that coding clients can stay on the user's computer and connect to
  cloud Flow. Server-side Flow jobs use OpenCode on the server.
- Keep credentials in private machine configuration and generated personal
  integration artifacts out of Git.
- Display CONNECTED PROJECT separately from the repository; their names can
  differ. Older gateways without that field need CLI identity verification.
- After initial authenticated remote setup, `flow setup <project>` reuses that
  named remote's private connection details and revalidates both endpoints.
  Explicit remote flags are required to change endpoints. Never silently pick
  another project when identity differs.

Archiving the completed Cursor chat did not emit sessionEnd in this test;
its captured turn remained idle and relies on the normal idle sweep.

Before publishing final help text, finish the remaining memory tests. Minimum
Codex compatibility remains unestablished. Evidence and updates: ../process.md.

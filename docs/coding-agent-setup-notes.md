# Coding agent setup notes for the info option

Product requirement: show an info option beside every coding agent. Explain
required permissions and setup, where to enable them, symptoms when missing,
and any version-specific limitations. These are observations from the isolated
local/cloud validation on 2026-09-06, not universal claims about every version.
Do not claim hook capture or extracted memory works based only on MCP success.

## Confirmed observations

| Agent | What the user needs to know | Symptom / recovery | Evidence |
| --- | --- | --- | --- |
| Claude Code | Authenticate Claude and allow the project's Flow MCP tools. Flow setup registers the server and read-tool permissions. | Revoked OAuth stops the session before Flow can run; reauthenticate and retry. | Claude 2.1.170 passed skill activation and native MCP locally and against HTTPS cloud after user reauthentication. |
| Codex CLI | Trust the project so its `.codex/config.toml` loads. Discover deferred Flow MCP tools before using CLI fallback. Hooks have a separate trust/enablement flow. | A sandboxed shell can fail `flow orient` networking while native MCP works. `--ignore-user-config` suppressed project MCP in the test. Use normal project configuration. | PATH Codex 0.136.0 native local/cloud MCP passed. Configured gpt-6-astra was incompatible with that older CLI; explicit gpt-5.5 worked without changing the user's global model. |
| Gemini CLI | Headless runs need explicit permission for skill activation and the MCP tools being tested. Interactive users can approve prompts normally; that interactive path still needs validation. | `mcp list` can show Connected and `skills list` Enabled while a headless session omits the tools. Allowing `activate_skill,mcp_flow-graph_orient` passed. Direct `read_file` on a personally installed skill may be rejected because it is Git-ignored; skill activation works. | Gemini 0.54.0 skill activation/native MCP passed locally and against cloud with limited per-invocation permission. `--allowed-tools` is deprecated in favor of Policy Engine; document a validated policy equivalent before recommending it as the long-term UX. |
| Cursor desktop | Enable the configured Flow MCP server for the workspace if Cursor marks it Disabled. | Observed path: Customize → Configure flow-graph → enable the fixture source. Status then changed to Connected with eight tools. CLI fallback requested a one-time Run approval; Always Run was not required. | Cursor read Flow skill and completed local CLI orientation; after enabling the workspace server, fresh native MCP orientation passed in about 13 seconds. |
| Antigravity desktop | Approve Flow MCP calls when prompted. A one-time approval was enough for the orientation test. | Local test displayed a tool approval prompt; selected “Yes, allow this time.” | Desktop read the installed skill and called native orient successfully. Cloud tool approval was accepted, but its result named the earlier harness-fixture repo and the agent stopped on a presumed project mismatch. Binding/reload verification is pending; this is not a cloud pass. |
| VS Code Copilot | Trust the workspace and approve/enable the Flow MCP server as required by VS Code. Hook permissions are separate from MCP. | The test showed a “Claude Code hooks available… Enable” banner; its relationship to Copilot's own hooks still needs verification. Do not imply enabling MCP enables all capture hooks. | Local desktop skill/native orient passed. Cloud desktop completion remains unverified; a cloud capture session exists, which alone does not prove skill/MCP success. |
| OpenCode | Configure an authenticated model provider. For Flow's server-side OpenCode, the supplied OpenRouter key is stored in private project configuration. | Single-agent setup formerly omitted the shared skill/instructions unless Codex was also installed; fixed in 9c2d3c1. Rerun setup after updating older installs. | Skill activation/native orient passed on Mac with local/cloud Flow and directly on Hetzner after standalone setup fix. |

## Codex executable and hook version quirk

Two installed versions were selected by different launch paths: shell `codex`
resolved to `/opt/homebrew/bin/codex` (0.136.0), while the Node 22 installation
and desktop app bundle provided 0.153.4. Show the **selected executable path
and its actual version**, not only the newest installed version.

The older headless `exec` produced no hook events even with the one-run hook
trust bypass. Its interactive session produced start/prompt/stop events. The
explicit 0.153.4 headless run produced a closed captured session, including
SessionEnd, and worked with the user's configured default model. This is an
observed version difference, not an established minimum supported version.
Recommend checking the selected binary before changing models or permissions.
Hook trust remains separate from workspace and MCP trust; the diagnostic
bypass is not a recommendation to permanently allow all hooks.

## Memory status evidence

Gemini cloud hooks completed the full pipeline: transcript capture, extraction,
stored memory, then retrieval by a fresh Claude session. Claude and current
Codex tests also captured transcripts, but the extractor returned no memories
for those particular prompts. That is not the same as a capture failure.
Agents without a session-end event may wait for the idle sweep (45-minute idle
threshold, checked every five minutes). Surface pending extraction separately
from a failed hook or an empty extraction result.

## Shared guidance for the UI

- Separate connection, skill availability, hook capture, and memory extraction
  status. Each needs distinct evidence and can fail independently.
- Explain that coding clients stay on the user's computer and can connect to
  cloud Flow; Flow's server-side jobs use OpenCode on the server.
- Personal setup keeps credentials in private machine config and generated
  project artifacts out of Git. Do not advise disabling ignore filtering globally.
- GUI-launched apps may not inherit shell Node/PATH settings. Setup now pins
  the installation Node runtime in generated commands; update/rerun setup if
  tools fail to spawn. The initial Node 24.10 installation had dependency/ABI
  problems; the validation used Node 22.22.3.
- Keep permission requests scoped. Read-only orientation approval does not
  establish that writes, execution, or hook upload permissions are enabled.
- Explain how to reconnect a misbound project with `flow setup <project>`.
  Never silently choose a different project when identity does not match.

## Still to verify before publishing final help text

- All desktop cloud runs.
- Actual hook permissions and ingestion for every supported integration.
- Repeat the verified Gemini hook → stored memory → fresh-session retrieval
  pipeline across the remaining integrations.
- Gemini Policy Engine equivalent for the limited headless permissions.
- Minimum compatible Codex version/model behavior; avoid an unconditional
  recommendation to change the user's model based on one environment.

Update this document alongside process.md as remaining tests establish facts.

Orientation now explicitly labels CONNECTED PROJECT separately from the repository.
A repository name can differ from its Flow project name; compare project identity
when checking the binding. Older gateways without this field require CLI verification.

Antigravity cloud retest: even a fresh conversation used an old orientation
response without CONNECTED PROJECT. The on-disk workspace MCP command points
to harness-cloud, so connection refresh/precedence remains unresolved. Its CLI
fallback was blocked by sandbox EPERM reading ~/.flow/bin/flow and requested
a separate one-time command approval. MCP approval alone did not permit the CLI.

After one-time command approval, Antigravity cloud CLI fallback returned the
correct harness-cloud project/cloud-fixture repository. Native cloud MCP remains
unverified; a fresh conversation alone did not resolve the stale response.

Remote reconnect: after the initial authenticated setup, `flow setup <project>`
can reuse that named remote's private connection details. It revalidates both
endpoints and preserves a previously registered repository name before updating
integrations. Explicit remote flags are still required to change endpoints.

OpenCode startup quirk: in the test deployment, `.opencode` had no package.json,
`npm prefix` resolved the Flow parent checkout, and background dependency install
failed with Unsupported engine on every task. Setup now creates a separate
pinned plugin manifest when absent and preserves existing user manifests.
The cloud template includes the same manifest. After installing its dependencies,
the measured follow-up fell from36.4s to8.6s; a fresh source question took13.7s.
These are individual observations, not a latency guarantee.

Antigravity hooks: bundled documentation distinguishes grouped tool-event hooks
from flat lifecycle hooks. Flow corrected PostInvocation/Stop to flat handlers
and verified a real cloud prompt/answer capture. Earlier no-capture observations
were affected by this format bug; memory extraction/retrieval is still pending
for this new session. Rerun setup after updating Flow to repair hook definitions.

Claude local automatic capture, extraction, storage and fresh-session retrieval
now pass end to end. A fresh session retrieved the 43-minute Willow constraint
with its exact memory ID using only Flow search. An earlier empty extraction
was not proof that the Claude hook integration was broken.

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
| Codex CLI | Trust the project so its `.codex/config.toml` loads. Discover deferred Flow MCP tools before using CLI fallback. Hooks have a separate trust/enablement flow. | A sandboxed shell can fail `flow orient` networking while native MCP works. `--ignore-user-config` suppressed project MCP in the test. Use normal project configuration. | Codex 0.153.4 native local/cloud MCP passed. Configured gpt-6-astra was incompatible with this installed CLI; explicit gpt-5.5 worked without changing the user's global model. |
| Gemini CLI | Headless runs need explicit permission for skill activation and the MCP tools being tested. Interactive users can approve prompts normally; that interactive path still needs validation. | `mcp list` can show Connected and `skills list` Enabled while a headless session omits the tools. Allowing `activate_skill,mcp_flow-graph_orient` passed. Direct `read_file` on a personally installed skill may be rejected because it is Git-ignored; skill activation works. | Gemini 0.54.0 skill activation/native MCP passed locally and against cloud with limited per-invocation permission. `--allowed-tools` is deprecated in favor of Policy Engine; document a validated policy equivalent before recommending it as the long-term UX. |
| Cursor desktop | Enable the configured Flow MCP server for the workspace if Cursor marks it Disabled. | Observed path: Customize → Configure flow-graph → enable the fixture source. Status then changed to Connected with eight tools. CLI fallback requested a one-time Run approval; Always Run was not required. | Cursor read Flow skill and completed local CLI orientation; after enabling the workspace server, fresh native MCP orientation passed in about 13 seconds. |
| Antigravity desktop | Approve Flow MCP calls when prompted. A one-time approval was enough for the orientation test. | Local test displayed a tool approval prompt; selected “Yes, allow this time.” | Desktop read the installed skill and called native orient successfully. Cloud desktop/capture tests pending. |
| VS Code Copilot | Trust the workspace and approve/enable the Flow MCP server as required by VS Code. Hook permissions are separate from MCP. | The test showed a “Claude Code hooks available… Enable” banner; its relationship to Copilot's own hooks still needs verification. Do not imply enabling MCP enables all capture hooks. | Local desktop skill/native orient passed. Cloud desktop and capture pending. |
| OpenCode | Configure an authenticated model provider. For Flow's server-side OpenCode, the supplied OpenRouter key is stored in private project configuration. | Single-agent setup formerly omitted the shared skill/instructions unless Codex was also installed; fixed in 9c2d3c1. Rerun setup after updating older installs. | Skill activation/native orient passed on Mac with local/cloud Flow and directly on Hetzner after standalone setup fix. |

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
- Hook → transcript → extraction → stored memory → fresh-session retrieval.
- Gemini Policy Engine equivalent for the limited headless permissions.
- Minimum compatible Codex version/model behavior; avoid an unconditional
  recommendation to change the user's model based on one environment.

Update this document alongside process.md as remaining tests establish facts.

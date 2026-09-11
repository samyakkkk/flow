# Agent Dispatch — Flow ↔ coding agents ↔ Shellular

Production cloud execution now uses the OpenCode conversation/worktree runtime
described in [Cloud Tasks](CLOUD_TASKS.md). The discussion below records the
earlier ACP/Shellular design; it is not the cloud task implementation contract.

How Flow triggers tasks on coding agents (Claude Code, Codex, OpenCode, Copilot,
Cursor), listens to their progress, and exposes the knowledge graph to them —
and where Shellular fits. Decided 2026-07-06 after reading the shellular,
claude-agent-acp, codex-acp, and opencode codebases.

## The two protocols (don't mix them up)

- **MCP** exposes tools *to* an agent (our graph verbs into Claude Code).
- **ACP** (Agent Client Protocol) drives an agent *from outside* (spawn,
  prompt, stream progress). Every major agent has an ACP face:
  `npx @agentclientprotocol/claude-agent-acp` (Apache-2.0),
  `@agentclientprotocol/codex-acp` (Apache-2.0), `opencode acp` (native).
- The bridge fact that makes zero-config possible: **ACP `session/new` accepts
  `mcpServers`**, and all three agents honor it — verified at
  claude-agent-acp `src/acp-agent.ts:3627`, codex-acp
  `src/codex_agent.rs:346`, opencode `src/acp/service.ts:194`. An ACP client
  injects Flow's graph MCP per session; no config files, no approval prompts.

## What Shellular is (and why we build on it)

Shellular (`shellular-org`, friend of the project — we can use it freely and
get protocol changes) is a host daemon + relay + phone/web app:

- **Host** (`npx shellular`, npm `shellular`): drives agents via ACP, plus
  terminals (PTY), fs, git, ports, HTTP proxy, sysmon.
- **On-device listeners** — the part we'd least want to rebuild:
  - `agents/session-watcher.ts` tails Claude Code / Codex on-disk session logs
    to surface sessions **the user started in their own terminal**, with
    working/finished lifecycle derived from log activity + process checks.
  - `agents/notify-bridge.ts` installs agent notify hooks to catch
    **waiting-for-permission** and authoritative finish — states that never
    hit the logs.
- **Relay** (`wss://api.shellular.dev`, open-source `shellular-org/server`,
  `--server` flag for self-hosting): host ↔ clients, E2E-encrypted
  (libsodium secretbox). Pairing secret is the QR payload `hostId:e2eeKey`;
  the key lives at `~/.shellular/shellular-<machineId>.e2ee` (0600).
- **Client protocol** (`@shellular/protocol`, typed zod schemas): everything a
  client can do — `AI_SESSION_CREATE {backend, prompt, workspacePath,
  mcpServers}`, prompt/abort/permission-reply, session list/attach/fork,
  messages replay, terminals, fs, git. Custom agents can be registered
  (`AiAgentsCustomAdd` — spawn command per agent).

## The decision

**Shellular is Flow's agent-execution plane. Flow is a headless Shellular
client — and, in the other direction, Flow becomes an ACP agent that Shellular
(and Zed, etc.) can drive.**

Flow does not rebuild the ACP harness, session store, log watchers, notify
hooks, permission plumbing, or cross-machine transport. It speaks
`@shellular/protocol` over the relay and gets all of it — including the case
local-only tooling can never reach: **Flow on EC2 dispatching tasks to the
user's laptop**, where the repos and the agent subscriptions already live.
The user's phone sees the same sessions in the Shellular app for free.

### Flow → agents (dispatch)

1. Orchestrator gains a `shellular-client` module: ws to relay, libsodium
   secretbox with the paired key, zod-validated messages.
2. **Pairing UX**: Sources page gets a "Machines" card. Same machine as the
   host → auto-pair (read the key file + machine id). Remote → paste the QR
   payload string (`hostId:key`). The connection then shows up in
   `shellular clients` for approval — done once.
3. **Trigger**: dashboard button / Linear automation / Slack message →
   `AI_SESSION_CREATE` with the user's preferred backend, `workspacePath` =
   the repo checkout on that machine, a prompt enriched with graph context
   (the answerer's anchors), and `mcpServers: [flow-graph]`.
4. **Listen**: session updates stream back → job transcript (existing JSONL
   infra) + humanized Activity feed; permission requests surface in the
   dashboard (`AiPermissionReply`) and on the phone. Results can be posted
   back to the Linear ticket (CONTEXT BY FLOW → "PR opened by Codex").

### Agents → Flow's graph (MCP)

- Gateway already has the MCP stdio adapter (`graph-gateway/src/mcp.ts`,
  same 7 verbs: find_entity, get_entity, read_query, list_schema,
  upsert_entity, upsert_relation, merge_entities).
- Add a **streamable-HTTP MCP endpoint** on the gateway (bearer token,
  read-only by default for external callers) — stdio only works
  same-machine; HTTP is what gets injected when the agent runs on a laptop
  and Flow runs on EC2. Both claude-agent-acp and codex-acp accept HTTP MCP
  servers in the injected list.
- For users running agents **by hand** (no Flow dispatch): on repo connect,
  Flow writes per-repo config — `.mcp.json` (Claude Code; one-time workspace
  trust + `enabledMcpjsonServers`), `opencode.json` (loads immediately),
  `.codex/config.toml` (trusted projects) — plus `flow mcp install` for
  user-scope registration everywhere.

### Flow *as* an agent (`flow acp`)

Expose the answerer/enricher as an ACP server (`flow acp`). Then Shellular's
app/web UI can register Flow as a custom agent — users ask Flow questions or
hand it tasks from the same interface that runs their coding agents (and from
Zed). This is the reverse direction: trigger Flow from anywhere, not just the
dashboard.

### The knowledge loop (listeners → brain)

Because the host also watches sessions the user starts themselves, Flow can
subscribe to that activity and feed it through the normal event pipeline
(classifier → policy → graph): "Claude Code ran in api-service, refactored
handler.ts publish path" becomes graph knowledge without anyone telling Flow.
This is opt-in per machine and respects the existing secret-scan gate.

## Build order

1. Gateway HTTP MCP endpoint + read-only flag for external callers.
2. Repo-config writer on connect + `flow mcp install` (user scope).
3. `shellular-client` module + Machines pairing card + dispatch v1
   (one backend first: Claude Code), progress → Activity + job transcript.
4. `flow acp` (answerer as ACP agent) → register in Shellular as custom agent.
5. Listener ingestion: user-started sessions → events → graph (opt-in).

## Licensing note

Shellular CLI/protocol are AGPL-3.0 — the same license as Flow, so there's no
tension: we consume the npm package as a dependency / separate process. The ACP
adapters we spawn are Apache-2.0 (permissive, flows into AGPL fine).

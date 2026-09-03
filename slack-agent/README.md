# slack-agent

Slack-native AI agent surface for Flow, built on Slack's current agent
experience (`agent_view`, agent sessions, streaming, stop). Slack is one
communication interface to a swappable `AgentRuntime` — the default runtime
asks Flow's knowledge graph + memory via the orchestrator's ask pipeline.

## Where the agent participates

| Surface | Behavior |
|---|---|
| 1:1 DM with the agent | Answers every message |
| Group DM including the agent | Answers every message (adding it = inviting it) |
| Channels (incl. Slack Connect) | Only when `@Flow` is mentioned; then plain replies in that thread continue the conversation |
| Existing human 1:1 DMs | Never — Slack only delivers `message.im` for the agent's own DMs |

Agent-session UX: running status with loading messages, streamed responses
(`sayStream` → `chat.startStream/appendStream/stopStream`), native stop button
(`agent_session_stopped` aborts the in-flight run), suggested prompts, and
thread context (`assistant_thread_context_changed` — "the channel the user is
viewing" is folded into the query).

## Setup (one dev workspace)

1. Create the Slack app: https://api.slack.com/apps → **Create New App → From
   a manifest** → pick your dev workspace → paste `manifest.json`.
2. **Basic Information → App-Level Tokens** → generate a token with
   `connections:write` (this is `SLACK_APP_TOKEN`, `xapp-…`).
3. **Install App** → install to the workspace → copy the **Bot User OAuth
   Token** (`SLACK_BOT_TOKEN`, `xoxb-…`).
4. `cp .env.sample .env` and fill in the two tokens plus
   `FLOW_ORCHESTRATOR_URL` / `FLOW_ADMIN_TOKEN` (from the Flow project's
   `data/projects/<name>/.env`).
5. `npm run --workspace slack-agent start` — Socket Mode connects (no public
   URL needed); health at `http://localhost:80/health`.

macOS ≥10.14 allows non-root binding of port 80. Set `SLACK_AGENT_PORT` to
move it.

## Runtime abstraction

`src/runtime/types.ts` defines the seam: `AgentRuntime.ask(RuntimeQuery) →
RuntimeAnswer`. Nothing Slack-specific crosses it. Implementations:

- `flow` (default) — `POST /v1/ask` on the orchestrator, polls
  `GET /v1/jobs/:id`; thread transcript is folded into the question.
- `echo` — echoes the prompt; for wiring smoke tests
  (`SLACK_AGENT_RUNTIME=echo`).

To swap in a customer-specific agent, webhook, or direct LLM call, add an
implementation in `src/runtime/` and register it in `src/runtime/index.ts`.

## Out of scope (for now)

Marketplace publishing, OAuth multi-workspace distribution, billing, customer
installation flows. HTTP (non-Socket) mode exists behind
`SLACK_SIGNING_SECRET` but needs a public URL in the app's event
subscriptions.

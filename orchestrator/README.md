# Flow Orchestrator

Event ingestion, LLM classification, policy routing, action execution, and job queue for the Flow knowledge agent. Runs on port **7500**.

## Quick start

```bash
cd flow/orchestrator
npm install
npm run dev
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `FLOW_ADMIN_TOKEN` | `dev-token` (warns) | Bearer token required on all routes except `GET /health` |
| `ORCHESTRATOR_PORT` | `7500` | HTTP listen port |
| `DB_PATH` | `data/flow.db` | SQLite database path (`:memory:` for tests) |
| `OPENROUTER_API_KEY` | — | Required for live LLM classification |
| `CLASSIFIER_MODEL` | `minimax/minimax-m3` | OpenRouter model for event classification |
| `GATEWAY_URL` | `http://127.0.0.1:7433` | Graph-gateway base URL |
| `GRAPH_NAME` | `acme-v1` | FalkorDB graph name |
| `GRAPH_BUILDER_MODEL` | `openrouter/minimax/minimax-m3` | Model passed to opencode run |
| `OPENCODE_WORKSPACE_DIR` | `<flow>/index-workspace` | Dir passed to `opencode run --dir` |
| `FLOW_DM_CHANNEL` | `flow-controller` | Slack channel for propose-mode DMs |
| `FLOW_TEST_LIVE` | unset | Set to `1` to use live LLM in tests (records new fixtures) |
| `FLOW_FAKE_OPENCODE` | unset | Set to `1` to use fake opencode in tests |
| `LOG_LEVEL` | `info` | Fastify log level |

## API routes

All routes require `Authorization: Bearer $FLOW_ADMIN_TOKEN` except `GET /health`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check (unauthenticated) |
| `POST` | `/v1/events` | Ingest normalized event → classify → policy → action |
| `GET` | `/v1/events/:id` | Event detail + classification + actions |
| `GET` | `/v1/config/policies` | Full policy toggle matrix |
| `PATCH` | `/v1/config/policies` | Merge policy overrides |
| `POST` | `/v1/ask` | Question → answer job (use `?wait=true` to block) |
| `GET` | `/v1/jobs/:id` | Job status + result |
| `GET` | `/v1/corpus/search` | FTS5 search over slack/linear/meeting corpus |
| `GET` | `/v1/audit` | Recent audit log rows |
| `GET` | `/v1/outbox` | Outbox rows (default `?status=pending`) |

## Scripts

```bash
npm run dev      # tsx watch (hot reload)
npm run start    # tsx (production-ish)
npm run test     # node:test suite
npm run verify   # tests + smoke boot check
```

## Normalized event shape

```json
{
  "id": "uuid",
  "source": "slack|linear|github|meeting|dashboard",
  "type": "message|mention|merge|webhook|...",
  "ts": 1720000000000,
  "payload": {},
  "workspace": "optional-workspace-id"
}
```

## Classification taxonomies

- **slack_ambient**: noise | knowledge_claim | correction | task_discussion | ticket_status_signal | question_about_system | sensitive
- **slack_mention**: question | command | feedback
- **github_merge**: skip | index_worthy
- **linear_ticket**: needs_context | duplicate_candidate | unresolvable | not_applicable
- **meeting_segment**: decision | action_item | knowledge_claim | open_question | noise

## Policy matrix defaults

- `sensitive` → always dropped (hardcoded, not configurable)
- `noise`, `skip`, `not_applicable` → off
- `task_discussion`, `ticket_status_signal`, `action_item`, `duplicate_candidate`, `unresolvable` → propose
- All others → auto


## Session memory checkpoints

Live sessions use `memory/checkpoint.ts` through `memory/trigger.ts`. Every five
minutes the scheduler checks sessions with new transcript events, including active
sessions; closure also queues a checkpoint immediately. `FLOW_DISTILLER=0` disables
these triggers. No new events means no model call.

A persisted job freezes the full retained transcript, repo/branch, and the range
`(last_distilled_seq, through_seq]`. Earlier events are context only. The model
returns up to five claims with `evidence_seqs`; every claim must reference real
substantive events and at least one event in the new range. Invalid JSON or
citations fail the job without consuming the range. A failed job resumes before
new arrivals are scheduled. Context is not silently slimmed; an over-budget model
request fails and remains pending, so large-session compaction is future work.

Validated extraction output is saved before applying observations. Stable
job/item IDs and transactional observation attachment make partial application
safe to retry. Evidence is counted by distinct session/event references for these
observations, while legacy observations retain their existing counting behavior.
Earlier citations remain in the saved extraction output but do not reinforce a
memory again. Citation validation proves that events exist, not that the claim
is semantically supported; extraction instructions distinguish fresh evidence
from assistant repetition.

The cursor and job completion are committed together after every observation has
been applied. Pending jobs recover on startup and subsequent sweeps. Scheduling
is serialized per session within the project's single orchestrator process.
Inspect `memory_distill_jobs` for ranges, attempts, pending/done status and errors;
`observation_events` links applied evidence to source event IDs. This is independent
of explicit `remember`, auto skills, and future rolling conversation summaries.

## Slack channel archive and backfill

The Slack agent's existing Socket Mode connection captures channel messages,
including ambient messages from other Slack Connect teams. These are source
records, not extracted memories. `slack_archive` retains the latest raw message
payload and file metadata; `slack_messages` provides FTS5 keyword retrieval through
`search_knowledge` and `/v1/corpus/search?source=slack&q=...`, with channel IDs and
Slack links. Edits update the index; deletion events remove text and leave a
versioned tombstone so stale backfill cannot restore it. Credential-bearing
payloads are screened out. This first path does not download/index image contents
or compute Slack embeddings.

The Web API worker discovers channels and backfills joined channels, including
thread replies, with persisted cursors and an upper timestamp per history scan.
It respects Slack retry delays and checks for new top-level history every five
minutes. It resumes existing pagination after a process restart. Live events
capture new replies to old threads; edits, deletions, and old-thread replies missed
while offline are not comprehensively reconciled by incremental history yet.

Deployment checks (using the project's existing authenticated orchestrator API):

1. Reinstall/update the Slack app with the manifest's `channels:join` scope if it
   was installed before this change; retain its history/read/event scopes.
2. Check `GET /v1/slack-agent/status` and `GET /v1/slack-agent/archive`; wait until
   `discovering` is false.
3. `POST /v1/slack-agent/join-public-channels` explicitly joins visible,
   unarchived public channels. Inspect both `joined` and `failed`. Private channels
   require invitations by existing members; the bot cannot discover/join all of
   them itself. Boot alone does not join uninvited public channels.
4. Inspect archive channel message counts, cursor, `synced_at`, errors, pending
   threads and `thread_errors`. Scope/rate failures must not be mistaken for
   complete backfill. Search known phrases from two channels and a thread reply.

Invocation checks use the sender's `users.info` home team, not the event wrapper's
team ID: external or unverifiable users cannot invoke/continue/cancel Flow.
Answers requested by internal users in Slack Connect channels go to their DM;
routing failures do not fall back to posting a shared answer. Known channels the
bot has left are excluded from corpus search. Retrieval otherwise follows Flow's
existing project-level access model, not individual Slack channel membership;
only include private channels whose content is appropriate for that project.

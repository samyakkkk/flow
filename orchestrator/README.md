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

# Local Quickstart

Two ways to run Flow locally. **Host mode is the default** and the only mode that
supports real opencode indexing.

---

## Host Mode (recommended — works today, supports opencode)

In this mode FalkorDB runs in Docker; everything else runs directly on your
machine with `npm`.  This is exactly how the nightly build agent runs Flow.

### Prerequisites

- Docker Desktop running
- Node.js 22 (check: `node --version`)
- `opencode` CLI on PATH (for index/answer jobs; skip if using
  `FLOW_FAKE_OPENCODE=1`)

### 1. Start FalkorDB

```bash
docker run -d \
  --name flow-falkordb \
  -p 6379:6379 \
  -p 3000:3000 \
  -v flow-falkordb-data:/data \
  falkordb/falkordb:latest
```

FalkorDB browser UI: http://localhost:3000

### 2. Start the graph gateway

```bash
cd graph-gateway
GRAPH_NAME=acme-v1 npm start
# Listening on :7433
```

### 3. Start the orchestrator

```bash
cd flow/orchestrator
export FLOW_ADMIN_TOKEN=<your-token>
export OPENROUTER_API_KEY=<your-key>
export GATEWAY_URL=http://localhost:7433
export GRAPH_NAME=acme-v1
# Add Slack/Linear/GitHub vars as needed (see ../.env.example)
npm start
# Listening on :7500
```

### 4. Start the dashboard

```bash
cd flow/dashboard
export ORCHESTRATOR_URL=http://localhost:7500
export GATEWAY_URL=http://localhost:7433
export FLOW_ADMIN_TOKEN=<your-token>
npm run dev     # dev mode with HMR on :7600
# OR
npm run build && npm start   # production build
```

Dashboard: http://localhost:7600

### 5. (Optional) Start Linear mock for offline testing

```bash
cd flow/simulators
npm run linear-mock
# Mock Linear API on :7509
```

---

## Full Docker Mode (limited — no opencode)

All four services run in Docker via `docker compose`.

### OpenCode limitation (v1)

The `opencode` CLI is **not bundled** in the orchestrator container.  When an
`index_repo` or `answer` job is queued, the orchestrator will attempt to spawn
`opencode run …` and fail with "command not found".

**Workarounds:**

| Option | Description |
|--------|-------------|
| `FLOW_FAKE_OPENCODE=1` | Use a deterministic fake (for demos, smoke tests). Set in `.env`. |
| Hybrid mode | Run FalkorDB + gateway + dashboard via compose; run orchestrator on the host (see Host Mode). Point `GATEWAY_URL=http://localhost:7433`. |
| Mount opencode | Mount the opencode binary into the container (`volumes: - /usr/local/bin/opencode:/usr/local/bin/opencode`) and set `OPENCODE_WORKSPACE_DIR` to a mounted index-workspace. Advanced; requires the container to have access to cloned repos. |

### Quick start (docker compose)

```bash
# 1. Clone repo and enter the flow/ directory
cd flow-workspace/flow

# 2. Set up environment
cp .env.example .env
# Edit .env: fill in FLOW_ADMIN_TOKEN and OPENROUTER_API_KEY at minimum

# 3. Build and start
docker compose up --build

# Dashboard: http://localhost:7600
# Gateway:   http://localhost:7433
# Orchestrator: http://localhost:7500
# FalkorDB browser: http://localhost:3000
```

Stop everything: `docker compose down`

Destroy data volumes too: `docker compose down -v`

### Environment variables

Copy `.env.example` to `.env` and fill in values.  The compose file reads
from `.env` automatically (Docker Compose default).

---

## Verification

From the repo root (any mode):

```bash
# Host mode — runs typecheck + unit tests + scenarios + dashboard smoke
bash flow/verify-all.sh

# Include real credential tests (Linear, GitHub, OpenRouter)
FLOW_VERIFY_REAL=1 bash flow/verify-all.sh
```

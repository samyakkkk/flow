# Running Flow locally

There is **one** way to run Flow: the `flow` CLI. It starts FalkorDB (in Docker,
for you), builds the dashboard once, and launches each project's services
natively. Do **not** run `docker compose` for local dev — that's an experimental
full-container path (see the bottom of this file).

---

## Prerequisites

- **Node 22+** — `nvm install 22 && nvm use 22` (there's an `.nvmrc`). The install
  refuses older Node with a message, because the agent adapters need 22 and
  SQLite ships prebuilt binaries for 22.
- **Docker running** — Flow starts FalkorDB (its graph database) in a container.
  Already run FalkorDB yourself? Point Flow at it and skip Docker:
  `FALKOR_HOST=<host> FALKOR_PORT=<port> flow up`.
- A **coding CLI** — indexing runs through whichever of opencode, Codex, or
  Claude Code is on your machine (`INDEXER_RUNTIME`, default auto-detects
  opencode → codex → claude). None installed? `./setup.sh` installs opencode
  through a signed channel (Homebrew / the official installer — never the npm
  binary, which macOS kills as unsigned).
- An **LLM provider** — paste an OpenRouter key into the dashboard on first run,
  skip if your coding CLI is already signed in, or point Flow at any
  OpenAI-compatible API (`LLM_BASE_URL` + `LLM_API_KEY` in Settings).

---

## Start it

```bash
git clone <repo> && cd flow
./setup.sh              # deps + environment checks + coding CLI install if none found
npm install -g .        # `flow` on your PATH

flow up mycompany       # creates it if new, then starts
```

`flow up` prints your dashboard URL. In local mode you're already signed in — no
token to paste. Then, in the browser:

1. **Give Flow a brain** — paste an OpenRouter key, or skip if a supported coding
   CLI (opencode, Codex, or Claude Code) is installed, since indexing runs through
   whichever is present (`INDEXER_RUNTIME`, default auto-detects opencode → codex →
   claude). Classification and semantic search stay off until an LLM key is set.
2. **Connect a repo** from the Home picker and watch the graph build.
3. **Ask** from the floating bar, or head to **Agents** to run a coding task.

### Everyday CLI

```bash
flow up   [name]     # start a project (creates it if new); no name = all
flow down [name]     # stop a project; no name = all
flow ls              # projects, status, dashboard URLs
flow doctor          # health-check every project (pages + assets + services)
flow rm   <name>     # stop and delete a project and its data
```

Each project is a self-contained `data/projects/<name>/` (its own graph, DB,
secrets, cloned repos) on its own port triplet. Projects share one FalkorDB via
named graphs.

---

## Verification

```bash
flow doctor          # all-green = pages, assets, and services are healthy

bash verify-all.sh   # typecheck + orchestrator tests + scenarios + dashboard smoke
```

---

## Under the hood (you don't need this)

`flow up` does what you'd otherwise do by hand: start FalkorDB, then run the
gateway (`:7433+`), orchestrator (`:7500+`), and dashboard (`:7600+`) for each
project with the right env. If you're debugging one service, run it directly
with `npm start` in `graph-gateway/`, `orchestrator/`, or `dashboard/` — but for
normal use, always go through `flow up` (it manages ports, the shared dashboard
build, and restarts).

### Experimental: full-container deploy

`deploy/docker-compose.yml` builds every service into an image (used for EC2).
It is **not** the local path and boots slower. If you really want it:

```bash
cd deploy
cp ../.env.example .env   # fill in FLOW_ADMIN_TOKEN + OPENROUTER_API_KEY
docker compose up --build
```

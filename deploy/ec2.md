# EC2 Deployment

Production deployment of Flow on AWS EC2 (or any Docker host). One container
runs the same `flow` CLI as a laptop install — in **prod mode** (login,
per-user grants, personal access tokens) — with FalkorDB as a sidecar. Only
the dashboard is exposed to the internet (via Caddy + HTTPS); each project's
gateway and orchestrator stay on 127.0.0.1 inside the container.

> Simpler alternative: skip Docker entirely — install Node 22 on the box and
> run `flow project create <name> --mode prod && flow up <name>` directly,
> then front `localhost:7600` with Caddy. The container path below is the
> same thing with packaging.

---

## Recommended instance

| Use case | Instance | Notes |
|----------|----------|-------|
| Development / staging | `t3.medium` (2 vCPU, 4 GB) | Enough for FalkorDB + one project |
| Production (small team) | `t3.large` (2 vCPU, 8 GB) | Headroom for graph growth + several projects |
| Production (large graph) | `m6i.xlarge` (4 vCPU, 16 GB) | Recommended once graphs exceed ~500k nodes |

**Storage:** 20 GB gp3 root volume (FalkorDB graph + SQLite + dashboard build).

**Security group:** open **only port 443** (HTTPS) to the internet, and SSH
from your IP. Do not expose 7600 directly — Caddy fronts it.

---

## 1. Launch and configure the instance

```bash
ssh -i ~/.ssh/your-key.pem ubuntu@<EC2_PUBLIC_IP>
```

Install Docker (docs.docker.com/engine/install/ubuntu) and Caddy
(caddyserver.com/docs/install). Add the ubuntu user to the docker group.

---

## 2. Clone and start

```bash
git clone https://github.com/samyakkkk/flow.git
cd flow/deploy

# Optional: name the project (default "main") and pass an LLM key for the
# headless indexer/classifier:
#   export FLOW_PROJECT=acme
#   export OPENROUTER_API_KEY=sk-or-...

docker compose up --build -d
docker compose logs -f flow
```

First boot builds the dashboard (~1–2 min), creates the project in prod
mode, and prints a **setup code**:

```
Setup code: ab12cd34 (works once — manage accounts in Settings afterwards)
```

---

## 3. Configure Caddy (HTTPS)

```bash
sudo cp Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # replace YOUR_DOMAIN
sudo systemctl enable --now caddy
```

Your domain needs a DNS A record pointing at the instance first. Caddy
obtains and renews the Let's Encrypt certificate automatically.

---

## 4. First login and accounts

1. Open `https://YOUR_DOMAIN/login` → create the **owner** account with the
   setup code from the logs.
2. Add teammates in **Settings → Access** (email + password + per-project
   grants). Members only see projects they're granted.

## 5. Connecting machines and agents

- **`flow connect https://YOUR_DOMAIN`** on a teammate's machine runs the
  device flow: browser approval mints that machine a personal access token
  (with the approver's grants) and registers it under `remotes` in
  `~/.flow/config.json`. Manage/revoke on the dashboard's `/connect` page.
- **MCP for coding agents**: `https://YOUR_DOMAIN/<project>/mcp` (streamable
  HTTP), bearer = a personal access token. Example:
  `claude mcp add --transport http flow https://YOUR_DOMAIN/<project>/mcp`.
- Revoking a user or token in the dashboard cuts their MCP/agent access
  within seconds (the gateway re-verifies tokens against the auth store).

## 6. More projects

```bash
docker exec -it deploy-flow-1 node bin/flow.mjs project create beta --mode prod
docker exec -it deploy-flow-1 node bin/flow.mjs up beta
```

Every project gets its own gateway/orchestrator (internal ports) behind the
same dashboard: `https://YOUR_DOMAIN/beta/...`.

---

## What is and isn't exposed

| Surface | Exposed publicly? |
|---------|-------------------|
| 443 → Caddy → dashboard (:7600) | YES — HTTPS only |
| `/<project>/mcp` | YES — via the dashboard, PAT-bearer-authed |
| FalkorDB (6379) | NO — compose network only |
| Per-project gateway/orchestrator | NO — 127.0.0.1 inside the container |

## Security notes

- The auth store (`data/auth.json` on the `flow-data` volume) holds password
  hashes (scrypt), PAT hashes (sha256), and the session-signing secret — the
  volume is the thing to protect and back up.
- Webhook secrets (`LINEAR_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET`) are set
  per project via the dashboard Settings once running.
- Upgrades: `git pull && docker compose up --build -d` — data lives on the
  volume, not in the image.

## Logs and maintenance

```bash
docker compose logs -f flow        # all services (flow up tails them)
docker compose down                # stop (volumes kept)
docker compose down -v             # stop and DELETE all data (irreversible)
```

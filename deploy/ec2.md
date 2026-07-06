# EC2 Deployment

Production deployment of Flow on AWS EC2.  Only the dashboard is exposed to the
internet (via Caddy + HTTPS).  The gateway and orchestrator stay on the Docker
network / localhost.

---

## Recommended instance

| Use case | Instance | Notes |
|----------|----------|-------|
| Development / staging | `t3.medium` (2 vCPU, 4 GB) | Enough for FalkorDB + gateway + orchestrator + dashboard |
| Production (small team) | `t3.large` (2 vCPU, 8 GB) | Headroom for graph growth and concurrent classifier calls |
| Production (large graph) | `m6i.xlarge` (4 vCPU, 16 GB) | Recommended once graph exceeds ~500k nodes |

**Storage:** 20 GB gp3 root volume (FalkorDB graph + SQLite corpus).

**Security group:** Open **only port 443** (HTTPS) to the internet.
Caddy handles HTTP→HTTPS redirect.  Do not expose 6379, 7433, 7500, or 7600
directly — they bind on the Docker network and localhost only.

---

## 1. Launch and configure the instance

```bash
# Connect via SSH (replace with your key and IP)
ssh -i ~/.ssh/your-key.pem ubuntu@<EC2_PUBLIC_IP>
```

### Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) \
  signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# Allow the ubuntu user to run docker without sudo
sudo usermod -aG docker ubuntu
newgrp docker
```

### Install Caddy

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

---

## 2. Clone the repository

```bash
git clone https://github.com/acme/flow.git
cd flow
```

---

## 3. Configure environment

```bash
cd flow
cp .env.example .env
nano .env    # or your preferred editor
```

Required values to fill in:

```
FLOW_ADMIN_TOKEN=<generate with: openssl rand -hex 32>
OPENROUTER_API_KEY=<your OpenRouter key>
GRAPH_NAME=acme-v1
```

Optional (add when you have the credentials):
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`
- `LINEAR_API_KEY` / `LINEAR_WEBHOOK_SECRET` / `LINEAR_DEFAULT_TEAM_ID`
- `GITHUB_PAT` / `GITHUB_WEBHOOK_SECRET` / `FLOW_WATCHED_REPOS`

**OpenCode on EC2:**
The orchestrator container cannot spawn the `opencode` CLI.  For v1 on EC2,
you have two options:

1. **No indexing yet:** Set `FLOW_FAKE_OPENCODE=1` in `.env` to allow the
   stack to start.  Ingest and classify events without running index/answer jobs.

2. **Hybrid mode:** Run `docker compose up falkordb gateway dashboard` to
   start the infrastructure containers, then run the orchestrator on the host
   (`cd orchestrator && npm start`) after installing Node 22 and opencode.

---

## 4. Build and start

```bash
# From flow-workspace/flow/
docker compose up --build -d

# Follow logs
docker compose logs -f

# Check health
docker compose ps
```

Expected startup order: `falkordb` → `gateway` → `orchestrator` → `dashboard`.
Allow ~60 seconds for all health checks to pass.

---

## 5. Configure Caddy (HTTPS reverse proxy)

Only the dashboard is exposed publicly.  The orchestrator is accessed by the
dashboard's Next.js API routes on the Docker network (server-side only).

```bash
sudo cp flow/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile    # replace YOUR_DOMAIN with your actual domain

sudo systemctl enable caddy
sudo systemctl start caddy

# Verify TLS cert was issued
curl -I https://YOUR_DOMAIN/login
```

Caddy automatically obtains a Let's Encrypt certificate.  Your domain must have
a DNS A record pointing to the EC2 instance's public IP before running Caddy.

### What is and isn't exposed

| Port | Service | Exposed publicly? |
|------|---------|-----------------|
| 443  | Caddy → dashboard (:7600) | YES — HTTPS only |
| 6379 | FalkorDB Redis | NO — Docker network only |
| 3000 | FalkorDB browser | NO — localhost only |
| 7433 | graph-gateway | NO — Docker network only |
| 7500 | orchestrator | NO — Docker network only |
| 7600 | dashboard | NO — proxied via Caddy |

If you need to access the FalkorDB browser from your local machine, use SSH
port forwarding:

```bash
ssh -L 3000:localhost:3000 ubuntu@<EC2_PUBLIC_IP>
# Then open http://localhost:3000 in your browser
```

---

## 6. Security notes

- **FLOW_ADMIN_TOKEN:** Use at least 32 random bytes (`openssl rand -hex 32`).
  This token gates all orchestrator API endpoints.  If leaked, rotate it and
  restart the orchestrator.

- **Webhook secrets:** Set `LINEAR_WEBHOOK_SECRET` and `GITHUB_WEBHOOK_SECRET`
  to strong random values.  The orchestrator validates HMAC signatures on
  incoming webhooks.

- **Security group:** The EC2 security group must allow **only port 443**
  inbound from `0.0.0.0/0` (and your SSH key on port 22 from your IP only).
  All other ports should be closed.

- **`.env` file permissions:** Ensure only root/ubuntu can read it:
  ```bash
  chmod 600 flow/.env
  ```

- **Upgrades:** Pull new images and rebuild:
  ```bash
  cd flow-workspace/flow
  git pull
  docker compose up --build -d
  ```

---

## 7. Logs and maintenance

```bash
# Live logs from all services
docker compose logs -f

# Logs from a specific service
docker compose logs -f orchestrator

# Stop everything (keep volumes)
docker compose down

# Stop and destroy all data (irreversible)
docker compose down -v
```

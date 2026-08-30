# Deploying Flow on Hetzner Cloud

A step-by-step, tested walkthrough for standing up a self-hosted Flow deployment on a Hetzner
Cloud server, with real HTTPS. Complements `deploy/ec2.md` (the generic Docker deploy) with
Hetzner specifics and the two things that trip people up: **ARM stock** and **TLS without owning
a domain**.

Everything below was run end-to-end on a fresh box. Where a step has a gotcha, it's called out.

---

## 1. Pick a server

**Cloud, not Dedicated.** Hetzner Cloud is a VPS you spin up in seconds, bill hourly, resize in
~30s, and delete when done. Dedicated (Robot / server-auction) is physical hardware with a
monthly commitment — overkill for this.

**Size — 4 GB RAM is the real floor.** On first boot Flow builds the dashboard (Next.js, a
1–2 GB spike) *while* the gateway loads a ~1 GB local embedding model, plus FalkorDB + the
orchestrator, plus an opencode index job. 2 GB will OOM. Recommended:

| Plan | Specs | ~€/mo | Notes |
|---|---|---|---|
| **CX23** (x86) | 2 vCPU / 4 GB / 40 GB | ~7 | Minimal, works with swap (below). What this guide uses. |
| CX33 / CPX32 (x86) | 4 vCPU / 8 GB / 80 GB | ~12 | Comfortable; no swap needed; faster indexing. |
| CAX11 / CAX21 (ARM) | 2–4 vCPU / 4–8 GB | ~7–12 | Cheaper + snappier **if in stock** — see the ARM gotcha. |

> **ARM gotcha:** Hetzner's ARM (CAX) line is the best value, and Flow's whole stack is
> ARM-clean (FalkorDB ships arm64, `node:22` is multi-arch, node-llama-cpp + opencode build on
> arm64). **But CAX is frequently sold out** — creating one returns
> `resource_unavailable / error during placement`. If so, either retry later or use the x86 CX
> line (identical behavior). ARM is **EU-only** (Nuremberg / Falkenstein / Helsinki).

**Location:** any EU or US region; only affects dashboard latency. This guide uses `nbg1`
(Nuremberg).

---

## 2. Create the server

Console: https://console.hetzner.cloud → New Project → Add Server. Pick **Ubuntu 24.04**, the
server type from above, add your **SSH key**, and — importantly — attach a **cloud-init** that
sets up swap so a 4 GB box survives the first-boot build. Paste this in the "Cloud config" field:

```yaml
#cloud-config
swap:
  filename: /swapfile
  size: "4G"
package_update: true
```

**Firewall:** create one allowing inbound **22 (SSH), 80 + 443 (HTTPS/ACME)**. That's all the
public surface — the gateway and orchestrator stay internal.

<details>
<summary>Or create it via the API (what this guide actually did)</summary>

```bash
export HCLOUD_TOKEN=<your read/write API token>   # console → project → Security → API Tokens

# upload your SSH public key
curl -s -X POST -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' \
  https://api.hetzner.cloud/v1/ssh_keys \
  -d "{\"name\":\"flow\",\"public_key\":\"$(cat ~/.ssh/id_ed25519.pub)\"}"

# firewall (22/80/443)
curl -s -X POST -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' \
  https://api.hetzner.cloud/v1/firewalls -d '{
    "name":"flow-fw",
    "rules":[
      {"direction":"in","protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"]},
      {"direction":"in","protocol":"tcp","port":"80","source_ips":["0.0.0.0/0","::/0"]},
      {"direction":"in","protocol":"tcp","port":"443","source_ips":["0.0.0.0/0","::/0"]}
    ]}'

# server (fill in ssh_keys / firewalls ids from the two calls above)
curl -s -X POST -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' \
  https://api.hetzner.cloud/v1/servers -d '{
    "name":"flow","server_type":"cx23","image":"ubuntu-24.04","location":"nbg1",
    "ssh_keys":[<KEY_ID>],"firewalls":[{"firewall":<FW_ID>}],
    "public_net":{"enable_ipv4":true,"enable_ipv6":true},
    "user_data":"#cloud-config\nswap:\n  filename: /swapfile\n  size: \"4G\"\n"
  }'
```
</details>

Note the server's **public IPv4**. SSH in once it boots: `ssh root@<IP>`. Confirm swap is on:
`free -h` should show `Swap: 4.0Gi`.

---

## 3. Install Docker & get the code

```bash
# on the box
curl -fsSL https://get.docker.com | sh
git clone https://github.com/<your-org>/flow.git /root/flow   # or scp/rsync your checkout
```

---

## 4. Configure and start

```bash
cd /root/flow/deploy
cat > .env <<EOF
FLOW_PROJECT=main
FLOW_DASHBOARD_PORT=7600
OPENROUTER_API_KEY=sk-or-...        # REQUIRED — see note
EOF

docker compose up --build -d
docker compose logs -f flow          # watch the first boot; the setup code prints here
```

> **OpenRouter key is required.** A headless server has no logged-in coding CLI, so the indexer
> runs **opencode driven by OpenRouter** (opencode is baked into the image; OpenRouter is its
> model provider). Without the key, repos connect but never index. Get one at
> https://openrouter.ai/keys.

First boot builds the dashboard (~1–2 min on a 4 GB box — the swap carries the spike), creates
the project in prod mode, and prints:

```
Setup code: ab12cd34 (works once — manage accounts in Settings afterwards)
```

At this point the dashboard is live on the box at `http://<IP>:7600` (not yet public unless you
opened 7600). **Don't stop here** — put HTTPS in front of it.

---

## 5. HTTPS — the important part

Flow's dashboard drives agents on your machine **from the browser via `localhost`**, and Chrome
only allows a page to reach `localhost` from a **secure (HTTPS)** origin. So a raw
`http://<IP>:7600` deployment works for the CLI/MCP paths but **not** for "run agents here" in
the browser. Put a real cert in front.

### Option A — you have a domain

Point an A record (e.g. `flow.yourco.com`) at the IP, then:

```bash
apt-get install -y caddy   # caddyserver.com/docs/install
printf 'flow.yourco.com {\n    reverse_proxy localhost:7600\n}\n' > /etc/caddy/Caddyfile
systemctl restart caddy
```

Caddy auto-provisions a Let's Encrypt cert. Done — `https://flow.yourco.com`.

### Option B — no domain (testing): nip.io + Caddy

`nip.io` is free wildcard DNS: `<dashed-ip>.nip.io` resolves to your IP, so Let's Encrypt can
issue a cert for it — real HTTPS without buying a domain.

```bash
DOMAIN="$(curl -s ifconfig.me | tr '.' '-').nip.io"   # e.g. 167-233-240-21.nip.io
apt-get install -y caddy
printf '%s {\n    reverse_proxy localhost:7600\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
systemctl restart caddy
echo "https://$DOMAIN"
```

Give Caddy ~15s for the cert, then open `https://<dashed-ip>.nip.io`. (Ports 80 + 443 must be
open for the ACME challenge — step 2's firewall covers it.)

> **Stable identity:** Flow keys each deployment by a URL-independent `deploymentId`, so moving
> from `http://<IP>:7600` to `https://<domain>` — or a later IP change — is handled gracefully:
> reconnecting a machine to the new address **updates the existing remote in place** instead of
> creating a duplicate. Prefer a real DNS name so the URL survives IP changes entirely.

---

## 6. First login and accounts

1. Open `https://<domain>/login` → create the **owner** account with the setup code from the logs.
2. **Settings → Access**: add teammates (email + password + per-project grants). Members only
   see projects they're granted.

## 7. Build the brain

On the dashboard home, connect a source (GitHub repo / local folder). The server clones it and
opencode indexes it into the knowledge graph via your OpenRouter key. A small repo indexes in a
couple of minutes; watch `docker compose logs -f flow` for `[indexer] … done`.

## 8. Connect machines & coding tools

- **One-command install:** the dashboard shows a `curl … | bash -s -- --connect <url> --code …`
  command (pre-blessed for the logged-in user) that installs the Flow CLI and connects the
  machine in one shot.
- **Per repo:** `flow setup <project> --remote <name>` binds a local repo to the deployment's
  project — materializing capture hooks + a remote MCP registration into every coding tool's
  config. Agents then read the deployment's brain over MCP and their sessions distill back into
  its shared memory.
- **MCP endpoint** for any harness: `https://<domain>/<project>/mcp` (bearer = a personal access
  token from the dashboard, or minted by `flow connect`).

---

## Sizing reality (measured)

On the minimal **CX23 (2 vCPU / 4 GB)** with 4 GB swap: the first-boot dashboard build succeeded,
and a real repo index (`sindresorhus/slugify` → 14 nodes / 350 edges) completed in ~6 minutes
with **2.3 GB RAM still free and swap barely touched**. The minimal box genuinely works; step up
to 8 GB only if you'll index several large repos or host many projects concurrently.

## Maintenance

```bash
docker compose logs -f flow          # all services
docker compose down                  # stop (data volume kept)
docker compose down -v               # stop and DELETE all data
git pull && docker compose up --build -d   # upgrade
```

**Cost:** a CX23 is ~€7/mo + ~€0.60/mo for the IPv4, billed hourly — cents for a day of testing.
Delete the server in the console (or `DELETE /v1/servers/<id>` via the API) to stop billing.

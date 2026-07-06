<div align="center">

# Flow

### Flow knows your stack.

A self-hostable **knowledge graph + agent runner for your codebase.** Point it at your repos and it builds a living graph of your services, capabilities, APIs, and how they connect — then answers questions with citations and runs your existing coding agents (Claude Code, Codex, OpenCode) with that graph injected into every session.

<img src="docs/images/home.png" width="760" alt="Flow dashboard — the live brain graph of your codebase with a floating Ask bar" />

[Quickstart](#quickstart) · [What you get](#what-you-get) · [How it works](#how-it-works) · [Roadmap](ROADMAP.md) · MIT licensed

</div>

---

## Why Flow

Coding agents are only as good as the context you feed them, and most of a codebase's real structure — which service owns what, what depends on this API, what breaks if you change a response field — lives in people's heads or scattered across repos.

Flow builds that structure into a graph and puts it at the center of everything. It's genuinely useful for a **solo developer working across several repos** — it maps the connections *between* your services and repositories (which frontend calls which backend capability, what a shared library is used by), so both you and your coding agents reason across the whole system, not one repo at a time. The same graph then **grows into a team brain** as you connect Slack, Linear, and meeting transcripts.

Run it on your laptop, or **host it on your own EC2** (or any always-on box) and drive everything — the graph, agents, and integrations — from the cloud. Your data stays on your infrastructure either way.

The graph is the center. Both you and your agents build from it.

---

## What you get

### Understand your codebase

- **A living knowledge graph** — connect a repo and OpenCode workers index it into a graph of services, capabilities, APIs, resources, and the *usage contracts* between them. Every claim carries evidence, confidence, and provenance, written through a single governed gateway so many writers can't rot the ontology.
- **Grounded Q&A with citations** — ask from a floating bar on any page. Answers come back with `file:line` evidence, a plain-language confidence, and the answer's subgraph highlighted on the graph — not a guess.
- **A graph you can actually read** — a force-directed constellation (FalkorDB's own renderer) with degree-sized, type-colored nodes and semantic zoom; click any node for a plain-language card.

### Run your coding agents from one place

<!-- TODO: agent-session screenshot (model picker, "consulted the brain" markers, live graph highlight) from a public demo repo -->

- **Claude Code, Codex, and OpenCode**, detected on your machine and driven over the [Agent Client Protocol](https://agentclientprotocol.com) from the dashboard — no terminal juggling.
- **Pick the model per session** — Claude Code (5 models + effort), Codex (2 models + reasoning effort), OpenCode (500+ models). The choice applies live and survives reload.
- **Full session control from the browser** — streaming transcript with collapsible thinking and tool rows, follow-up steering when idle, mid-run interrupts, Stop, real permission cards (Allow / Always allow / Reject), and agent-mode switching.
- **The graph is injected into every session** as a read-only MCP (`find_entity` / `get_entity` / `read_query` / `list_schema`). The agent gets grounded context for free — no config files — and the session view **highlights the exact nodes it consults**, live ("7 nodes consulted by this session"), with "consulted the brain" markers in the transcript.

### Grow into a team brain

- **Connect Slack, Linear, and Fireflies** meeting transcripts alongside your repos, all from the dashboard. Conversational knowledge attaches to the graph without overwriting code-derived truth.
- **CONTEXT BY FLOW on Linear tickets** — an auto-maintained, idempotent section enriched with code truth and related discussion, so whoever (or whatever) picks up the ticket starts with the full picture.
- **Everything is a policy toggle** — every automated behavior is auto / propose / off, and every action is audited with provenance.

---

## Quickstart

**Prerequisites:** Node 20+, Docker (runs FalkorDB), the [opencode](https://opencode.ai) CLI (the agent runtime), and an [OpenRouter](https://openrouter.ai) API key for the models. To run coding agents, install whichever you use — Claude Code, Codex, and/or OpenCode; Flow detects them.

```bash
git clone <repo> && cd flow
npm install && npm install -g .    # deps + `flow` on your PATH

flow project create mycompany
flow up mycompany                  # prints your dashboard URL
```

Then it's all in the browser:

1. **Open the dashboard URL** and log in with the project's `FLOW_ADMIN_TOKEN` (printed at create time, and in the project's `.env` — the one secret that lives in a file).
2. **Paste your OpenRouter key** in Settings (nothing else is reachable until the brain has a model).
3. **Connect a repo** from the Home picker (uses your `gh` login, a PAT, or a public URL) and watch the graph build.
4. **Ask a question** from the floating bar, or head to **Agents** to kick off a coding task.

> A one-command installer (`curl … | bash`) that also provisions opencode + Docker is on the [roadmap](ROADMAP.md). The steps above are the current path.

### CLI

```
flow project create <name> [--mode local|prod]
flow up   [name]     # start project(s); no name = all
flow down [name]     # stop project(s); no name = all
flow ls              # table of projects + status + URLs
```

Each project is a self-contained folder (`data/projects/<name>/`) with its own graph, database, secrets, and cloned repos. Multiple projects run side by side on separate port triplets, sharing FalkorDB via named graphs.

---

## How it works

Flow is a small set of local services, graph at the center:

```
connect sources ──▶ agents build the evidence-backed graph ──▶ answers, agents & context
  (repos, Slack,        (OpenCode workers write through a          (grounded Q&A, coding-agent
   Linear, meetings)     governed gateway; every claim              sessions with the graph
                         has provenance + confidence)               injected, Linear context)
```

**Three storage tiers**, each holding a claim exactly once:

- **FalkorDB graph** — distilled durable knowledge (services, capabilities, usage contracts). One named graph per project.
- **SQLite corpus (FTS)** — searchable evidence: Slack messages, a Linear mirror, meeting segments. What graph claims cite.
- **Systems of record** — Slack / Linear / GitHub stay the source of truth; fast-moving state is joined at read time, never frozen into the graph.

The **orchestrator** runs a deterministic pipeline — event → LLM classifier → policy lookup (auto / propose / off) → single-write action layer → audit log. Agents produce content; only the service performs side effects, which is what makes the permission matrix enforceable and defends against prompt injection. All graph writes go through the **gateway's** typed verbs (never raw Cypher), so the ontology stays clean under many concurrent writers.

Full design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); agent-dispatch design in [`docs/AGENT_DISPATCH.md`](docs/AGENT_DISPATCH.md).

---

## Using your coding agents

<!-- TODO: Agents-page screenshot from a public demo repo -->

1. **Connect a repo** on Home so there's a checkout for the agent to work in.
2. Open **Agents** — installed agents (Claude Code / Codex / OpenCode) show up with live detection; missing ones show install hints.
3. Kick off a task: pick an agent, a connected repo, a model + effort level, and write your prompt.
4. **Steer it** — send follow-ups when it's idle, interrupt and redirect mid-run, approve or reject permission requests from the browser, switch agent mode, or Stop.
5. **Watch the graph light up** — the session panel highlights the exact nodes the agent queries, and answers come back citing real files.

The dashboard never spawns processes itself — everything rides the orchestrator's HTTP API, so the same flow will work in cloud mode later.

---

## Connecting more sources

<!-- TODO: sources screenshot from a public demo repo -->

All sources are configured **in the dashboard**, not in env files. Keys are AES-256-GCM encrypted in the project database, masked in responses, and hot-applied — adding a key starts its poller immediately, no restart.

- **GitHub** — connect repos with the picker (gh CLI, PAT, or public URL); each gets indexed into the graph.
- **Linear** — polled since a cursor; tickets enriched with CONTEXT BY FLOW.
- **Fireflies** — meeting transcripts ingested as searchable evidence (plus manual meeting-note upload).
- **Slack** — ambient in-thread answering. **Deploy-only:** a laptop can't be always-on, so local mode locks Slack ("deploy to enable").

Non-Slack sources all use one poll-since-cursor mechanism, so catching up after downtime — a 30-second reboot or a 3-day outage — is the same operation.

---

## Self-hosting

Flow runs the same everywhere; the mode decides what's on.

- **Local** (`--mode local`, default) — build the graph, ask questions, run coding agents, poll GitHub / Linear / Fireflies. Slack is disabled. This is the solo-developer path and needs nothing but your laptop + Docker.
- **Deployed** (`--mode prod`, on a small always-on box like EC2) — everything above plus the always-on Slack bot.

Your data stays on your infrastructure. A single admin token guards every HTTP surface, agents that read untrusted content never hold write-to-the-world tools, and every action is audited.

One-command install, `flow export` / `import` project migration (local → EC2 by moving one bundle), and systemd-managed always-on deploys are on the [roadmap](ROADMAP.md).

---

## Roadmap

Shipped and honest about what's next — see [`ROADMAP.md`](ROADMAP.md) for the full detail. Highlights of what's coming:

- **One-command installer** (`curl -fsSL … | bash`) that provisions Node + opencode + Docker.
- **Agent dispatch across machines** via Shellular + a streamable-HTTP graph MCP endpoint, so Flow on a server can drive an agent on your laptop with the graph injected.
- **Per-repo MCP config on connect** + `flow mcp install`, so your own hand-run agents get the graph tools too.
- **`flow acp`** — expose Flow's answerer as an agent you can register in Shellular or Zed.
- **Project migration** (`flow export` / `import`) and **EC2 always-on** under systemd.

Flow is early and moving fast. See [`CHANGELOG.md`](CHANGELOG.md) for dated history.

---

## Contributing

Issues and PRs welcome. Everything is testable without real credentials — the simulators drive the full pipeline.

```bash
bash verify-all.sh   # typecheck + orchestrator tests + simulator scenarios + dashboard smoke
```

Please run `verify-all.sh` before opening a PR and add a `CHANGELOG.md` entry. For larger changes, open an issue first to discuss the approach.

## License

MIT — see [`LICENSE`](LICENSE).

## Acknowledgements

Built on the shoulders of [OpenCode](https://opencode.ai) (the agent runtime), [FalkorDB](https://www.falkordb.com) (the graph store and its renderer), and the [Agent Client Protocol](https://agentclientprotocol.com) (driving Claude Code, Codex, and OpenCode from one place).

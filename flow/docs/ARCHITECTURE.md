# Flow — Architecture

The design and the decisions behind it. For status see `../ROADMAP.md`, for
history `../CHANGELOG.md`, for behavior specs `scenarios.md`.

## What Flow is

A self-hostable knowledge agent for engineering teams. It builds a living,
evidence-backed graph of a company from ground truth (repos, Slack, Linear,
meetings) and exposes it through a Slack bot, Linear context blocks, and a
dashboard. Local for building/trying; a $12/mo always-on box for ambient use.

## Three-tier storage (a claim lives in exactly one tier)

1. **FalkorDB graph** — distilled durable knowledge: services, capabilities, usage contracts, concepts. Small, curated. One named graph per project.
2. **Corpus (SQLite FTS)** — searchable evidence: Slack messages, Linear mirror, meeting segments. What graph claims cite; what agents search.
3. **Systems of record** — Slack/Linear/GitHub stay the source of truth. Fast-moving state (ticket status) never enters the graph; it's joined at read time.

Rule: **the graph stores what stays true; systems of record keep what's in motion; the resolver joins them at read time.**

## Single write path (the gateway)

All graph mutations go through graph-gateway verbs (never raw Cypher): typed,
schema-validated, provenance-required (actor + evidence + confidence), dedup-checked
at write time, and journaled. This is what keeps many writers (orchestrator + N
opencode sessions) from rotting the ontology.

Biz + code claims share one graph, governed by provenance not storage: conversational
claims (`actor: slack:…` / `meeting:…`) attach and never overwrite code-derived
fields; trust is visible at read time; triage traverses contract edges only.

## The pipeline (orchestrator)

```
event (Slack/Linear/GitHub/meeting/dashboard, or a poller)
  → LLM classifier (strict-JSON, per-source taxonomy)
  → policy lookup: "<source>.<classification>" → auto | propose | off
  → action layer  (the ONLY place external side effects happen)
     → graph write via gateway, or Slack/Linear via outbox→drainer, or opencode job
  → audit_log (every classification + action, with provenance)
```

Two hard boundaries:
- **Agents produce content; the service performs side effects.** OpenCode sessions get repo-read + `graph_*` (+ read-only integration tools). They never hold `slack_post`/`linear_write`. They return structured results; the orchestrator decides what to do per the policy toggles. This is what makes the permission matrix enforceable and defends against prompt injection.
- **Every automated behavior is a dashboard toggle** (auto / propose / off). Deterministic policy-as-data, not a free-running supervisor agent.

Intelligence is distributed: a cheap classifier call at each decision point; full agent loops delegated to OpenCode workers.

## Ingestion: poll-since-cursor (one mechanism)

Every non-Slack source polls since a stored cursor (`poll_cursors`), producing
NormalizedEvents into the one pipeline. Catch-up after downtime is free — a 30s
reboot and a 3-day outage are the same operation. Webhooks, if added, are only a
"poll now" nudge, never a separate path. Slack is the exception: Socket Mode
(outbound stream, prod-only, always-on).

## Multi-project model

A project = `{gateway, orchestrator, dashboard}` on a port triplet, bound to a
graph name + SQLite file + workspace dir. FalkorDB is the shared substrate (named
graphs isolate). One folder per project (`data/projects/<name>/`) holds
project.json, `.env`, flow.db, journal, and `workspace/` (`.opencode` +
`repos/`). Delete the folder = project gone; migrate = move the bundle (repos
re-clone from the registry).

- **Local mode**: build/enrich/ask + polling integrations. Slack blocked (a laptop can't be always-on).
- **Prod mode** (EC2): everything, Slack included, under systemd for auto-restart.

## Components & ports

| Component | Port | Role |
|---|---|---|
| FalkorDB | 6379 / 3000 | graph store + browser (shared, named graphs) |
| graph-gateway | 7433 | typed verbs + journal over FalkorDB |
| orchestrator | 7500 | pipeline, corpus, jobs, adapters, auth |
| dashboard | 7600 | Next.js, token-gated |

(Per project, ports are the base + a stride so instances coexist.)

## Stack choices

- **OpenCode** = the agent runtime (headless sessions, model-agnostic via OpenRouter). Not eve — eve stays a candidate future home for the orchestrator switchboard; skipped for beta-risk.
- **Orchestrator** = plain TypeScript (Fastify) — deterministic plumbing with LLM calls at decision points, not an agent framework.
- **Models** = OpenRouter (one key, any model, embeddings included). Workers on a frontier coding model; classifier on a cheap fast one.

## Auth

Single admin bearer token (`FLOW_ADMIN_TOKEN`, per project) guards every HTTP
surface except `/health`. Webhooks authenticate by HMAC; the notify endpoint
accepts the admin token or a per-job scoped token (so an injected agent can't
reach the whole API). Dashboard sets an httpOnly cookie; middleware gates pages.

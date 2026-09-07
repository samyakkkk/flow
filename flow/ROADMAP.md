# Flow — Roadmap

What's shipped, what's next. See `CHANGELOG.md` for dated change history and
`docs/ARCHITECTURE.md` for the design.

## Design record — memory v2 final form: distiller-only + orient docs (2026-07-18/19, Samyak — SUPERSEDES the 2026-07-10 three-lane consent model)

The 07-10 record priced consent by blast radius across three lanes (procedures
command / corrections mutate truth / notes color judgment). Dogfooding killed
the first lane: agents classifying "is this a procedure?" produced junk
proposals ("LLM gets confused about what is a procedure and creates random
procedures"). Final form — ONE writer, the distiller; agents never classify:

- **Branch notes: REMOVED** (PR #41). Observations carry {repo, branch,
  session} mechanically, so a separate agent-authored note lane was redundant.
- **`remember`: the one active-capture door** (PR #41). User says "remember
  this" → the model sends text, nothing else. Instant ack, async distillation,
  source_weight floors to user_stated, verbatim fallback so an explicit
  remember is never lost. It feeds the pipeline, not the store.
- **No repo gating inside a project** (PR #43). The project is the trust
  boundary (one flow.db per project, physically separate). Within it, repo
  affinity is RANK (+0.08 same repo, +0.04 family sibling), never eligibility;
  consolidation candidates are project-wide so cross-repo repetition merges
  and strengthens. Retrieval-eval re-run still owed to confirm precision.
- **Orient docs: the ambient tier** (validated 2026-07-19 by rendering the doc
  from the 47 real bench-store memories BEFORE building — Samyak approved the
  page). One doc per scope ('global' + 'repo:<name>'), returned verbatim and
  UNCAPPED by orient() — the auto-authored AGENTS.md (~10k tokens is fine;
  supersedes the old ~1.5k orient cap). Mechanics: the distiller NOMINATES
  (`ambient` flag per observation — cheap, recall-oriented); INCLUSION is
  earned (user_stated fast-tracks; agent/error claims wait for evidence ≥ 2;
  contradiction_count = 0 required — one contradiction evicts the line; kind
  'plan' never enters). Membership is a DERIVED VIEW recomputed from the
  memories table each rebuild — connect/disconnect happens by evidence, no
  doc-editing machinery, memories stay primary. Render v1 is deterministic
  (claims grouped by kind, each line carrying [mem:id] for drill-down); an
  LLM prose-polish can replace the renderer later without touching membership.
- **Procedures: REMOVED (2026-07-19)** — the proposal/review/retire verbs,
  Procedure node type, GOVERNS edge, inbox + instant-dialog lanes, and
  insert-mode injection are gone; the one blessed procedure migrated into
  memory via `remember`. Durable rules now enter exclusively through the
  distiller and earn their way into the orient docs.
- Unchanged: corrections lane (machine-verified, different problem), pull-only
  retrieval, search_knowledge, anchoring, strength/decay.

## Notes & cautions — decided-for-now, revisit deliberately

Concerns a human flagged as "keep this in mind" — not rules, not tasks
(roadmap items). Each entry: the concern, who raised it, when, and what
triggers the revisit. Remove when resolved (note the resolution in the
changelog).

- **Corpus exposure to sessions widens exfiltration** (2026-07-10). When
  `search_corpus`/ticket reads land on the session MCP, a prompt-injected
  agent can read Slack history, not just code+graph. Fine local/single-user;
  must be a per-project policy toggle before any shared deployment.
- **Question-driven retrieval must not recurse** (2026-07-10). If an
  answerer-style tool is ever exposed inside sessions, answerer sessions get
  quick-mode tools only — no nested deep calls.

## Shipped 2026-07-10 — Procedures + graph corrections (see CHANGELOG)
Governed proposal lanes for coding agents: `propose_procedure` /
`propose_retire_procedure` (human bless/retire via Inbox + instant dashboard
dialog; deletion human-only, enforced in the gateway — upsert/merge reject
Procedures) and `correct_graph` (flags verified by the indexer against the
repo's base-branch checkout; verdicts to the Inbox; unparsable = `unclear`,
never silently applied). Retrieval: GOVERNS ambush, semantic trigger match,
insert-mode injection at session start. Open follow-ups, priority order:
1. **Scope the correction verifier's writes** to the flagged node ids — today
   it's a full-write graph-builder fed agent-authored text (prompt-injection
   escalation path).
2. **Tests**: corrections lifecycle + procedure verbs into the orchestrator
   suite / a simulator scenario (currently hand-run smokes only).
3. **Gateway auth**: localhost HTTP gateway serves `review_procedure`
   unauthenticated — any local process can self-bless; matters more now that
   blessing gates auto-injection.
4. **Render proposal payloads in the ACP permission card** (external-lane
   consent is title-only today; ties into the CLI-consent caution above).
5. **`supersedes` on propose** — "the rule changed" should be one action, not
   retire + re-propose fighting the dedup gate.
6. **Turn-boundary insert injection** (today session-start only; a mid-session
   steer into governed territory doesn't re-match) + trigger-threshold tuning
   (0.65 was tuned on entity lookups, not triggers).
7. **Surfaced-vs-followed analytics** for injected procedures (activity stream
   records surfacing; nothing measures follow-through).

## RESOLVED 2026-07-19 — turn-boundary memory injection REMOVED
The per-turn `[flow memory]` push (disabled by default since 2026-07-10) is
deleted along with its two content sources (branch notes in PR #41, the
procedures lane in the memory-v2 final form). The design questions it posed
are answered by the two-tier model instead: ambient knowledge is ALWAYS
present via the orient docs (curated at write time, no ranking at read time),
and everything situational is pull-only (search_knowledge / find_entity).
`FLOW_MEMORY_INJECTION` no longer exists.

## Next — memory system v2: FINAL decisions (2026-07-10, supersedes the section below where they differ)

- **Retrieval stays `find_entity` → `get_entity(id)`** — the question-lens /
  brain() variants are shelved ("let's see how big it gets"); revisit when
  get_entity responses visibly bloat. (Bug fixed en route: get_entity was
  shipping each node's 1536-float embedding vector in props.)
- **Memory is not maintained by users.** Notes/decisions/cautions are UNGATED
  (attributed utterances, free lane); procedures stay gated for now but the
  direction is ungating them too. No approval queues for memory.
- **Branch notes live in flow.db** (`branch_notes`, keyed repo+branch), NOT
  in-repo md files (would tangle notes into the user's diff), NOT graph tags.
  Portable to EC2 via export/import. Kinds: `wip` (rolling state, supersedes
  itself, SWEPT at promotion — merged code carries that info) vs
  note/caution/decision (accumulate, PROMOTE to graph Note nodes).
- **Writers, three tiers by cost**: (1) FREE auto: rolling WIP note per
  session assembled from title + agent's latest message + session diff — zero
  LLM, zero discipline; (2) FREE agent-initiated `note` verb for in-the-moment
  discoveries/dead-ends/decisions; (3) LLM distillation deferred to MERGE
  time: hand the branch's session transcripts to the indexer agent during the
  merge reindex — one cheap pass per merge, not per session.
- **Promotion trigger = base-branch reindex**, not merge events: after every
  successful `index_repo`, promote base-branch notes + merge-marked branch
  notes (anchors resolve then — the entities exist post-reindex). Covers
  direct-push-to-base. Unpushed/abandoned notes decay.
- **Topology rule (first-class)**: agents may run LOCAL while Flow runs on
  EC2 over MCP — Flow never assumes a shared filesystem; `{repo, branch}`
  arrive as explicit tool args (runtime supplies them for dashboard sessions).
- **Auto-injection is the product** (dashboard-first; direct CLI is
  second-class by design): at session start AND every turn boundary, embed
  the user message once, match procedures (graph) + notes (flow.db, local
  cosine), inject top 2-3 one-line pointers in a marked block, per-session
  dedup, hard threshold, NO LLM in the path. MCP lane gets piggyback memory
  tails on tool responses (later).
- **Security LAST by explicit priority call**: verifier write-scoping,
  gateway bearer auth, permission-card payloads — after the memory work.

## Design record — memory system v2 exploration (2026-07-10)
Design record from the 2026-07-10 session — the rationale matters as much as
the items; don't re-derive, supersede deliberately.

- **Unified Note layer** (cautions + decision-rationale as ONE kind). A note
  is an *attributed utterance, not a truth claim* ("Samyak worried X on date
  D" is true even if the worry is wrong) — which is what makes it safe to
  **auto-write with no per-item approval**. WHY: consent priced by blast
  radius — procedures command agents (human-blessed, rare), corrections
  mutate shared truth (machine-verified against base branch), notes only
  color judgment (free lane). A human approval on every memory write turns
  memory into a chore queue and then it simply doesn't get used.
  Mechanics: ONE anchor link to whatever it concerns (semantic search covers
  the rest — links are a precision optimization, not a requirement; the kind
  determines edge semantics so agents only nominate targets, never relation
  types), decay by default (unconfirmed notes fade; wrong ones die on their
  own), gardening not gatekeeping (periodic digest review, usage-ranked
  trust from the activity stream), write-side hygiene (dedup-at-write,
  per-session budget). Decisions get a SUPERSEDES chain (ADR-style) and often
  anchor to a Concept (an area), not implementation nodes.
- **Branch-aware notes**: every note auto-carries {repo, branch, session} —
  tagged mechanically by the runtime (it spawned the checkout), never
  classified by agent or human. Retrieval scopes branch-tagged notes to
  sessions on that branch; on `github_merge` (pipeline already ingests it)
  promote or sweep; abandoned branches decay fast. This collapses the
  branch-scratch problem to two fields + a rank rule *for notes* (facts still
  need the full scratch design, deferred with worktrees).
- **Corpus + systems-of-record on the brain MCP**: sessions can see distilled
  claims but not the evidence behind them. Add read-only `search_corpus`
  (proxies the existing /v1/corpus/search), use provenance fields as the join
  key (graph node → corpus doc → Slack permalink / Linear URL), and proxy any
  freshness-critical live reads (ticket status) through the orchestrator so
  agents never hold credentials. See exfiltration caution above.
- **Retrieval modes — A/B, deliberately undecided** (Samyak: try both). Arm A
  = today's find_entity → get_entity chains. Arm B = question-driven
  `brain(question)` → budgeted BRIEFING (not an answer: entity cards, edge
  one-liners, top-3 ranked memory items with ids, labeled truncation) +
  `brain_detail(id, facet)` for full payloads when acting. NO LLM in the
  retrieval path (embed once + Cypher hops, ~200-400ms — the answerer's
  synthesis stays out of sessions for latency). Old verbs remain as aliases.
  The briefing RANKER is where memory policy lives: blessed > notes,
  recency/confirmation, branch scoping, hard caps with labeled truncation —
  "write freely, rank ruthlessly". Quick mode must return signposts (counts +
  one-liners), never bodies, or note-bloat kills the ambush pattern.
- **Sessions as an ingestion source (decision distillation)**: design
  conversations in agent sessions currently die with the transcript. Reuse
  the classify → policy → graphwrite pipeline (meeting `decision`s already
  become Concepts): session-end job distills decisions-with-rationale from
  agent-sessions/<id>.jsonl (actor `session:<id>`, policy-controlled).
  External-CLI sessions have no transcript inside Flow — needs a session-safe
  note/decision proposal verb (today sessions can only propose Procedures).
  All writes through the consent table above — nothing self-blessed (learned
  the hard way, same day).

## In progress — polish pass on the new UX
Core UX overhaul SHIPPED (see changelog): state-machine home, brain-graph hero, floating Ask bar, humanized activity. Remaining polish: state-detection nuances (sources vs repos), middleware→proxy rename (Next 16 deprecation), real end-to-end walkthrough with a fresh user.

## Shipped 2026-07-07 — Agents v1 (local)
Coding agents (Claude Code / Codex / OpenCode) run from the dashboard via the orchestrator's ACP runtime: kickoff, live streaming, steering, permissions, modes, replay; read-only flow-graph MCP injected per session with live brain highlighting. See CHANGELOG. Next for agents: PR-first task templates, resume sessions across restarts (loadSession), Linear-ticket → agent dispatch, cloud mode (containers behind the same API).

## Next — agent dispatch & MCP exposure (decided 2026-07-06, see docs/AGENT_DISPATCH.md)
Shellular becomes Flow's agent-execution plane; Flow drives coding agents as a headless Shellular client and exposes the graph to them via MCP. In order:
1. **Gateway HTTP MCP endpoint** (streamable-http, bearer token, read-only default for external callers) alongside the existing stdio adapter.
2. **Per-repo MCP config on connect** (`.mcp.json` / `opencode.json` / `.codex/config.toml`) + `flow mcp install` for user scope — users' own agents get graph tools.
3. **Dispatch v1 via Shellular** — `shellular-client` module (relay ws + libsodium), Machines pairing card, trigger a Claude Code task from the dashboard with Flow MCP injected per session (ACP `session/new mcpServers`), progress streamed into Activity + job transcripts.
4. **`flow acp`** — answerer as an ACP agent, registerable in Shellular/Zed as a custom agent (trigger Flow from their interfaces).
5. **Listener ingestion (opt-in)** — Shellular's session-watcher/notify-bridge events (user-started agent sessions) → Flow event pipeline → graph.

## Next (P1–P3)

### P1 — One-command install (`install.sh` / `get.flow.sh`)
Single script installs Node + opencode + Docker (FalkorDB) and puts `flow` on PATH; installs only what's missing. **Same script for laptop and EC2.** End-user experience: `curl -fsSL get.flow.sh | bash` → `flow project create` → `flow up`. No clone, no npm link (contributor-only).

### P2 — Project migration (`flow export` / `flow import`)
`export` bundles a project's FalkorDB graph + project.json + .env + flow.db; `import` restores on the target. Cloned repos re-clone from the registry (derived state). Migrate local→EC2 by moving one bundle; graph + human-corrected claims transfer intact.

### P3 — EC2 always-on (part of install, prod mode)
systemd per project (Restart=always + enable) → crashes and reboots self-heal, no manual `flow up`. EBS-persist + nightly snapshot → instance loss = ~5-min restore. Slack catch-up-on-reconnect (backfill via `conversations.history` since last-seen) → downtime is delayed, not lost. Caddy TLS, only dashboard public.

## Later — single control-plane dashboard
One dashboard per instance managing all projects (create/start/stop from UI, project switcher). Deferred by user decision — per-project URLs listed by `flow up` are fine for now.

## Later (P4 — monetization / managed)

GitHub App backend (no PAT) for managed. CloudFormation "Launch Stack" URL for one-click deploy to the user's own AWS (never hold their creds). Managed hosting as single-tenant instances (keeps the SSH-inspect + audit-log trust story). Revenue = convenience of running the always-on box, not the feature gate (self-hosters unlock free — that's the funnel).

## Backlog / quality (non-blocking)

Semantic (embeddings) corpus search alongside FTS · gateway-enforced biz-cannot-overwrite-code (currently actor-prefix convention) · Slack `command` classification → real actions · policy cache · marked→DOMPurify on ask page · docker ports → 127.0.0.1 bind · cross-project shared repo object store (clone-twice is fine until it isn't) · rename `FLOW_TEST_LIVE` (it gates the *production* live classifier — misleading name).

## Out of scope (v1)

Multi-user auth/SSO · eve migration. (MCP server exposure graduated to "Next — agent dispatch".)

## Shipped

- **Knowledge graph core** — repos indexed into FalkorDB via a governed gateway (typed verbs, provenance + confidence on every claim, dedup at write time, append-only journal). OpenCode agents build/enrich/answer.
- **Orchestrator** — event bus → LLM classifier → policy toggle matrix (auto/propose/off) → single-write action layer → outbox. SQLite corpus (FTS), job queue, audit log.
- **Integrations** — Slack (Socket Mode, prod-only), GitHub / Linear / Fireflies (poll-since-cursor), meeting upload. Linear CONTEXT BY FLOW (idempotent). Notify tool + session-per-chat.
- **Dashboard** — login, connections + repo picker (gh CLI / PAT), permissions matrix, ask page with graph viz, activity/audit, catching-up ingest panel, local/prod mode badge, **Settings page: all config (keys, models, intervals) editable in the UI, secrets encrypted, changes hot-apply (pollers start on key add, no restart)**. Only the bootstrap admin token lives in a file.
- **`flow` CLI** — `project create` / `up` / `down` / `ls`; per-project folders, auto-generated admin token, multiple projects side-by-side on port triplets, shared FalkorDB via named graphs.
- **Mode gating** — local = build/try (Slack locked "deploy to enable"); prod = always-on ambient.
- **Verification** — 72 orchestrator tests, 40 multi-workspace simulator scenarios, dashboard smoke, `verify-all.sh` (4/4). 155-scenario spec in `docs/scenarios.md`.


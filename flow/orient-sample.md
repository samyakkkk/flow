# `orient` tool — proposed output (mock for review)

Not implemented yet. This is what `orient({repo: "flow", branch: "flow/you-know-about-claude-fynw"})`
would return **today**, built from real data in the live graph. The idea: instead of
Flow pushing memory into prompts, the agent calls one tool at session start and gets
a compact index of everything Flow knows about this repo — then drills into whatever
it needs.

## Sample output (~280 tokens)

```
[flow orient — repo "flow" @ flow/you-know-about-claude-fynw]

BEHAVIOR (learned project rules — follow these):
- Show the screen before building: mock the output/UI and get it approved first.
- Explicit doors in user nouns — features are visible controls, not magic side
  effects.
- Design discussions are not build orders; don't write or commit mid-discussion.
(illustrative — these rules are LEARNED from conversations and approved by a
human, never hand-authored; "(nothing learned yet)" when empty)

WHAT THIS IS: Flow monorepo — self-hostable knowledge graph + agent runner for
codebases. graph-gateway (typed verbs over FalkorDB + MCP), orchestrator (event
pipeline, classifier, pollers, ACP sessions, :7500), dashboard (Next.js, :7600),
flow CLI. Multi-project: each project = own port triplet, shared FalkorDB.

MAP: 7 services, 75 API endpoints, 8 workflows, 12 usage contracts indexed.
Start from [svc:orchestrator], [svc:graph-gateway], [svc:dashboard].

PROJECT FACTS: (none stored yet)

PROCEDURES (1):
- Restart Flow projects one at a time, then verify the restart took — trigger:
  restarting Flow services / deploying Flow code to a running project.
  [proc:restart-flow-projects-one-at-a-time-then-verify-the-restart-took]
(when there are more than 5, orient shows the 5 most relevant plus a line like:
"…14 more — find_entity to search them". The front page never grows past its
budget; the store behind the [id]s can grow without limit.)

THIS BRANCH: (no notes yet)

HOW TO USE: drill any [id] with get_entity; search with find_entity; traverse
with read_query. Re-orient when: entering an unfamiliar area, a failure
surprises you, or after compaction. Store back: note (branch findings, free),
propose_procedure (durable rules, reviewed), correct_graph (graph ≠ code).
```

## Decisions I made to draw this — veto any

1. **The agent tells Flow where it is.** orient takes `repo` and `branch` as
   arguments. Flow never guesses from the folder it runs in, because the agent
   may be on a different machine (laptop agent, EC2 Flow). For sessions Flow
   spawns itself, Flow fills both in automatically.

2. **It lives on the existing MCP server.** One more tool next to find_entity /
   get_entity / read_query / list_schema. Cursor users and Flow-spawned sessions
   both get it with zero extra setup, and every orient call appears in the
   dashboard activity feed.

3. **Section order**: behavior rules → what this repo is → what's indexed →
   durable facts → procedures → this branch's notes → how to use Flow.
   Behavior comes first: it's instructions (always applies), memory comes after.

3b. **Behavior rules are learned, never hand-authored.** The whole point is
   removing the CLAUDE.md authoring burden — so there is no rules file and no
   settings text box to write. Rules enter as memory: an agent proposes one
   when the user states it ("always X"), and later the passive listener catches
   unstated ones from transcripts. The human's job is a tap — approve or
   reject (the review_procedure surface that already exists). Orient renders
   the BEHAVIOR section from approved memory: insert-mode procedures (meant to
   be shown proactively) feed BEHAVIOR; retrieve-mode ones feed PROCEDURES.

4. **Every list entry carries the actual information, not just a title.**
   "Restart projects one at a time — trigger: deploying Flow code" fires when
   relevant; "note about restarts" never would. The `[id]` at the end is what
   the agent passes to get_entity for full detail.

5. **Empty sections still show.** "(none stored yet)" costs a few tokens and
   teaches the agent these categories exist — and that it can write into them.

6. **Size limits.** Whole response under ~1.5K tokens, max ~5 items per section.
   When more exist: "12 more — find_entity for X", never a silent cut and never
   a dump.

7. **Simple selection rules for v1.** When more items exist than fit: procedures
   scoped to this repo, notes from this exact branch, newest first. No clever
   relevance scoring until the simple version visibly picks wrong things.

8. **GRAPH_PREAMBLE stays exactly as it is.** We only add one sentence telling
   agents to call orient first. (Samyak's call: don't shrink the preamble until
   orient has proven itself.)

## How we'll know orient is right (watch for these in real sessions)

1. Agents call it on their own at the start of a session, unprompted.
2. After calling it, they jump straight to the `[id]`s it returned instead of
   re-searching the graph from scratch.
3. When a stored fact is relevant to a session, it actually shows up in the
   agent's behavior.
4. The output stays under the size limit on every repo, not just this one.

## Two things orient depends on (separate work, don't block building the tool)

- **Nowhere to store durable project facts yet.** Flow has Procedures (rules
  with triggers) and Notes (branch-scoped), but no type for lasting
  project/strategy knowledge — e.g. "CLI is second-class, Flow's interface is
  first-class". That section stays "(none stored yet)" until this type exists.
- **Notes need a store that can't lose them.** Branch notes written earlier were
  silently dropped by the index/merge pipeline. Notes should be written once to
  a durable store (e.g. a flow.db table) and the graph copy rebuilt from it —
  orient should read from the durable store.

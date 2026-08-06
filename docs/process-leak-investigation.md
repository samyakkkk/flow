# Task: Flow process-leak investigation & lifecycle hardening

_Hand-off doc, 2026-08-06. Written from a live investigation on Samyak's Mac while working on
the remote-MCP branch. Goal for the receiving agent: understand the coding-agent **session
lifecycle** (direct vs Flow-spawned), pin down where Flow leaks OS processes, and fix it — this
matters for customers running Flow on long-lived EC2 boxes._

> Do NOT kill processes on the user's machine without explicit confirmation — it is their real
> working laptop with live Claude Code sessions and their own apps (olostep/batches) running.
> This task is about understanding + fixing the Flow code, not cleaning up this machine (that's
> a separate, user-approved step).

## The core question to answer

When does a coding-agent session actually END, and what OS processes does it leave behind?

1. **Direct Claude Code** (user runs `claude` in a terminal): what ends it, and does closing the
   terminal reliably reap it + its `flow-graph` MCP child?
2. **Flow-spawned agent sessions** (via the Agents page / ACP runtime): there is no terminal —
   so **when do these end, and what reaps their processes?** This is the crux.

## What the live investigation found (evidence)

Machine state during the session: **2,549 total processes — 918 zombies (Z) + 1,631 sleeping**.
macOS PID-table exhaustion was the actual cause of an unrelated Next.js build flake (prerender
workers couldn't `fork()` → "Expected workStore to be initialized"). Three distinct leaks:

### A. User's own dev environment (dominant, NOT Flow) — ~1,300 procs
- 422 `node --experimental-network-inspection --inspect-port=N` processes running
  `SupportWork/batches/src/index.js` (310), `olostep/api-olostep/index.js` (70),
  `olostep/save-result` (41). The flag is **VS Code Auto Attach**'s signature. Each nodemon
  restart attaches a fresh inspector and orphans the old process to launchd (PID 1). Ages
  9–56 days.
- Each of those `batches` instances leaks **one zombie child** → the bulk of the 918 zombies
  (parents are the `node@20 --inspect-port=… SupportWork/batches` procs, each owning 1 Z).
- **Fix is on the user's side** (turn off VS Code Auto Attach / fix the batches app's child
  reaping). Flagged here only so the receiving agent doesn't misattribute it to Flow.

### B. THE KEY FLOW FINDING — "days-old Claude sessions" are Flow ACP adapter children
The `claude` processes that looked like stale manual terminal sessions are **not** manual — they
are children of Flow's ACP adapter:

- `PID 49735 = node .../node_modules/.bin/claude-agent-acp`, **3d6h old**, parent chain → the
  orchestrator `48730` (a 3-day-old Flow deployment). **5 `claude` CLI children** hang under it.
- `PID 46484 = claude-agent-acp`, 6h old, under orchestrator `44765`. **2 `claude` children**.

So: Flow's orchestrator spawns one long-lived `claude-agent-acp` adapter per backend; that
adapter spawns a `claude` CLI **child process per agent session**; and those children are
**1–3 days old and not reaped** even though the user is not actively running 5–7 concurrent
agent tasks. Strong signal that **Flow-spawned agent sessions do not terminate their child
process on session close / idle-sweep** — every agent task leaves a `claude` process behind.

Relevant code (verify against current tree):
- `orchestrator/src/agents/runtime.ts` — ACP runtime. Memory notes: "Spawns a single shared
  subprocess per backend (so sessions share state)." Check whether `newSession`/session-close
  actually kills the per-session `claude` child, and what `onSessionClosed()` + the idle sweep
  do to OS processes (vs just marking the DB row closed).
- `agent_sessions` table has `status` (active|idle|closed|error). Cross-check: are the 5 live
  `claude` children mapped to sessions whose status is `closed`/`idle`? If yes → confirmed leak.
- The graph-gateway MCP server (`graph-gateway/src/mcp.ts`) DOES self-exit on stdin
  `end`/`close` — that path is clean for direct Claude Code. Confirm it also holds when the
  parent is `kill -9`'d (no clean EOF) — add a parent-death/SIGTERM guard.

### C. Orphaned Flow services on ungraceful shutdown — 5 stale orchestrators
Five `orchestrator/src/index.ts` processes, **26–30 days old**, `STAT=S` (alive, not zombie),
all running from `data/projects/flow/workspace/repos/flow/orchestrator` — a **self-indexed
source-clone path** (`data/projects/<project>/workspace/repos/<repo>` is where Flow clones
indexed sources). Someone ran `flow up` (or services were spawned) from inside a cloned source
checkout weeks ago; the controlling terminal died and the services **reparented to launchd and
never exited**. One still holds port 17501. Small RAM, but they hold ports + PID slots forever.
- `bin/flow.mjs` (`cmdUp`/`cmdDown`) + `bin/lib/*` — check pids.json tracking and the port
  sweep. `flow up` sweeps the ports it's about to claim, but does NOT reap prior instances of
  the same deployment living on *other* offsets/paths.
- One Flow agent-worktree process (`data/projects/olostep/.../worktrees/fulfillment-service`,
  was PID 41561) was sitting on **8 zombies** — spawns children (git? ACP?) without reaping.

## Lifecycle model to confirm & document

| | Ends when… | Reaps its children? | Leak vector |
|---|---|---|---|
| Direct `claude` in a terminal | terminal close → SIGHUP → process exits | MCP child gets stdin EOF → self-exits (clean) | only on `kill -9` of claude (no EOF) |
| Flow agent session (ACP) | **???** — no terminal; logical close/idle-sweep marks DB row | **apparently NOT** — `claude` child persists | every agent task leaks a `claude` process |
| Flow orchestrator/gateway | `flow down` | — | orphans to launchd if controlling shell dies without `flow down` |

The receiving agent should turn the "???" and "apparently NOT" into verified answers with
code references, then implement the fixes.

## Fixes to implement (customer-critical, priority order)

1. **Reap the per-session agent child on session end.** When a Flow agent session closes or the
   idle-sweep retires it, terminate the underlying `claude`/`codex`/`opencode` child process
   (SIGTERM → SIGKILL grace), don't just update the DB row. Verify no orphaned `claude` under
   `claude-agent-acp` after a session closes.
2. **Idle auto-shutdown (the "why don't they end when inactive" ask).** Flow-spawned sessions
   should have a real idle timeout that also frees the OS process, and the shared ACP adapter
   should shut down when it has zero live sessions for N minutes.
3. **Service reaper + heartbeat watchdog.** `flow down` kills every PID it ever spawned
   (pids.json, all offsets); `flow up` reaps stale same-deployment instances; add
   `flow doctor --reap`. Each orchestrator/gateway refreshes a heartbeat and **self-exits** if
   its controlling `flow` process is gone past a grace window (saves a customer EC2 that loses
   its controlling process). On EC2 the Docker/systemd unit contains this, but bare `flow up`
   needs it.
4. **Reap child_process spawns in the agent/worktree + ACP/git paths** — the process holding 8
   zombies spawns children without an `exit` handler / `wait`. Audit every `child_process.spawn`
   in `orchestrator/src/agents/*` and indexer paths; add exit handling or `detached+unref`
   correctly.
5. **MCP-server parent-death guard.** `graph-gateway/src/mcp.ts` self-exits on stdin close;
   add a periodic parent-PID check (or `process.on('disconnect')`) so a `kill -9` of the harness
   can't orphan it.

## How to reproduce / verify

- Count zombies: `ps -eo stat | awk '{print substr($1,1,1)}' | sort | uniq -c` (watch the `Z`).
- Watch Flow agent children: `ps -eo pid,ppid,etime,command | grep claude-agent-acp` and its
  `claude` children before/after starting AND closing a Flow agent session — the child count
  should return to baseline on close (it currently does not).
- Orphan test: `flow up <proj>` in a subshell, kill the subshell (simulate terminal death),
  confirm orchestrator/gateway are gone (they currently survive) — that's fix #3.
- After fixes, an EC2 running many agent tasks over days should hold a flat process count, not a
  monotonically rising one.

## Acceptance

- Closing / idling a Flow agent session leaves **zero** residual `claude`/`codex`/`opencode`
  child processes.
- Killing a deployment's controlling shell → services self-exit within the grace window.
- No zombies accrue from Flow processes under sustained agent-task load.
- Document the finalized lifecycle table in `docs/ARCHITECTURE.md`.

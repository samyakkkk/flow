# Cloud setup validation progress

User priorities: (1) real local alias setup and CLI/desktop integrations, then
Hetzner remote deployment/setup; (2) permission-aware remote code reading and
search for repositories absent locally; (3) existing coding-agent PR and
automation/worktree behavior. User authorized test servers, milestone commits,
and PR creation. An async question is pending for the existing PR number.

## Environment

- Branch: `codex/cloud-harness-validation`, based on `origin/main-dev` 49554e3.
- Worktree: `/Users/samyakjain/Documents/flow-workspace/flow-cloud-harness-validation`.
- Alias: `flow-cloud-test`, offset 12000; dashboard 19600, gateway 19433,
  orchestrator 19500. Project `harness-lab`, independent FalkorDB container
  `flow-falkordb-flow-cloud-test` on 18379. Main deployment untouched.
- Fixture: `data/harness-fixture`, separate Git repo, setup `--all`.
- Integration backup: `~/.flow/backups/cloud-harness-validation` (private).
- Use Node `/Users/samyakjain/.nvm/versions/node/v22.22.3/bin/node` for npm/tests.
- Heartbeat `flow-cloud-setup-overnight` resumes this work every 30 minutes.
  Pause when finished. Do not treat scheduled continuation as completed work.

## Verified

- Clean setup initially failed on system Node 24.10; Node 22.22.3 installs.
- Alias originally launched Node from the current PATH, causing SQLite ABI
  mismatch. Commit 1a50d80 pins the install Node and prepends its directory;
  native dependency probe now constructs/closes an in-memory database.
  Reran setup and `up`: services healthy. Syntax/diff checks passed.
- Existing materializer tests: 9/9 passed.
- Generated neutral CLI `orient`: correct fixture/project identity.
- Direct SDK stdio smoke: eight session tools available, `orient` succeeds.
- Claude 2.1.170: first run failed with revoked OAuth. User reauthenticated.
  `data/claude-local-authenticated.jsonl` confirms native MCP discovery,
  `mcp__flow-graph__orient` call, successful orientation. Startup hook ran.
- Gemini 0.54.0: `data/gemini-local-trusted.jsonl` confirms successful CLI
  fallback orientation. Native MCP was absent; reading ignored SKILL.md was
  refused by Gemini. Investigate both, do not mark full Gemini support passed.
- Codex 0.153.4 (PATH and app bundle): default configured gpt-6-astra rejected
  as requiring newer CLI; npm currently also reports 0.153.4. Initial test with
  `--ignore-user-config` discovered instructions but read-only shell blocked
  network fallback. A fresh test with explicit fixture trust and default model
  is running; logs `data/codex-local-isolated.{jsonl,stderr}`.
- Draft remote `/mcp` implemented using stateless SDK Streamable HTTP,
  existing bearer/PAT authentication, fixed project graph, session tools only,
  Origin allowlist and bounded request size. Typecheck passes. Smoke script
  `scripts/check-remote-mcp.mjs harness-lab` passes auth, initialization,
  discovery, read, cross-project rejection, write exclusion, Origin rejection.
  These endpoint changes still need review/commit and broader tests.

## Next

1. Finish local CLI evidence, verify capture ingestion (not just hooks fired).
   Investigate Gemini skill/MCP discovery and Codex compatibility. Desktop apps
   installed: Cursor, Antigravity, VS Code. Use agent-browser skill for UI tests.
2. Remote connection setup is not implemented yet: cmdSetup still requires local
   project files and writes localhost URLs. Add authenticated discovery/setup,
   remote MCP bridge or native per-client HTTP configuration with private
   credentials, and remote hook ingest through a restricted HTTPS proxy.
3. Provision Hetzner test server once connector is runnable; no cloud resources
   created yet. User supplied a token in the conversation; never put it in logs,
   this file, or git. Record created resources and cleanup commands.
4. Implement source read/search with repository access checks, revision-labelled
   results, bounded output, no traversal/symlink escapes, no arbitrary clones.
5. Identify existing coding-agent PR before merging. Open PRs inspected: 78, 69,
   68, 67, 66, 60, 57, 49, 30; none unambiguously matches. Ask remains pending.

Flow orient works but semantic graph search and memory calls return 401 in this
parent session. Do not conclude memory is empty from those errors. Read code.
Keep private raw test logs in ignored `data/`; commit only sanitized evidence.

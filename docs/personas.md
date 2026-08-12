# Flow — User Personas & Validation (2026-08-07)

Five personas that cover how a team actually adopts and lives with a
self-hosted Flow deployment. Each has a **journey** and an automated
**validation** (API-level in `scripts/persona-tests.sh`, browser-level via
agent-browser). "Working" = every persona's journey passes on the real
Hetzner deployment (`https://167-233-240-21.nip.io`, project `main`).

---

## P1 — Priya Nair · Founding Engineer / **Workspace Owner**
- **Who:** Technical founder standing up Flow for her 5-person team on their own server.
- **When:** Day 0, right after `docker compose up` on the box — creating the team brain.
- **What she does:** Bootstraps the owner account with the setup code, connects the
  team's GitHub repos with a fine-grained PAT, (optionally) wires Slack, invites teammates.
- **Why:** Wants one shared "ground truth" brain that captures every coding session and
  answers questions across all repos.
- **Validates:** bootstrap → owner role · GitHub PAT save → repo list → add repo → **index → brain node** ·
  member invite. *(All PASS as of T1.)*

## P2 — Alex Rivera · Backend Developer / **Member**
- **Who:** A developer on Priya's team; not an admin.
- **When:** Every morning — checks the brain, then codes in Claude Code all day.
- **What he does:** Logs in, browses the brain graph, sees the indexed repos, connects **his
  own** workspace (`flow setup`) so his sessions feed the brain. Cannot touch team integrations.
- **Why:** Wants his AI tools to carry the team's memory and to contribute his sessions back.
- **Validates:** member role · **read-only** integrations (0 Connect buttons) · brain read access ·
  own-tools panel present · **403** on any team-integration write. *(All PASS as of T1.)*

## P3 — Jordan Kim · Developer who **runs agents from the dashboard**
- **Who:** A member who likes driving Flow-run coding agents from the `/agents` page.
- **When:** Mid-task, wants Flow to spin a coding session on **his** machine with the team brain.
- **What he does:** Opens `/agents` on the prod dashboard, sees the local-execution card,
  runs `flow connect <deployment>` to bind his machine, then runs an agent locally whose
  brain queries/memory writes hit the deployment.
- **Why:** Wants ACP execution on his laptop but a shared remote brain.
- **Validates:** LocalExecutionCard states (not-connected → connected) · `flow connect` · **C2**
  (local exec + remote brain). *(C2 in progress.)*

## P4 — Sam Chen · **Returning Owner / brain reviewer**
- **Who:** The owner, a week and several redeploys later.
- **When:** After many sessions and at least one `docker compose up --build`.
- **What he does:** Logs in, confirms the brain survived redeploys, reviews captured
  sessions/facts, searches memory.
- **Why:** Only trusts Flow if the brain **persists and grows**.
- **Validates:** **D1 durability** across redeploy (brain node count survives) · graph growth · search.

## P5 — Maya Osei · **Consumer-app user** (ChatGPT / claude.ai)
- **Who:** A PM who lives in ChatGPT and claude.ai, not a coding CLI.
- **When:** Asks her assistant questions about the codebase/decisions.
- **What she does:** Installs the deployment's connector (no marketplace) so her ChatGPT /
  claude.ai can query the team brain.
- **Why:** Wants the brain where she already works.
- **Validates:** **D4** connectors without a marketplace — connector URL + token + skill upload. *(D4 pending.)*

---

## Status matrix (updated as runs happen)

| Persona | Journey | API test | Browser test | State |
|---|---|---|---|---|
| P1 Owner setup | bootstrap→GitHub→index→invite | ✅ | ✅ owner editor | **PASS** |
| P2 Member | read-only + link + 403 | ✅ | ✅ read-only view | **PASS** |
| P3 Agent runner | connect + local exec + remote brain | ⏳ | ⏳ | C2 pending |
| P4 Returning owner | durability + growth + search | ✅ (D1) | ⏳ | partial |
| P5 Consumer connector | connector install | ⏳ | ⏳ | D4 pending |

Run: `scripts/persona-tests.sh` (API-level, re-runnable). Browser evidence in `/tmp/persona-*.png`.

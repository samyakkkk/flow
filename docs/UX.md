# Flow — Dashboard UX

## North star

**The dashboard is the onboarding.** There is no separate setup wizard, no docs to
read. At every moment the screen shows you the single most important thing to do
next — and once Flow is alive, it shows you the brain growing, so you *feel* the
value being built. A first-time user should never wonder "what now?" or "where is
that setting?"

## Principles

1. **One clear next action.** A new user sees exactly one thing to do, not six tabs. Capability is revealed as you earn it.
2. **The brain is the hero.** The knowledge graph is the center of the screen, visibly growing as sources index. People should see it and feel it — this is what they're building.
3. **Show the work.** Indexing is live and legible ("Reading api-service… 34 facts so far"), never a silent background job.
4. **Validate, don't assume.** A key is *tested* before you move on. You're never allowed to connect GitHub while the brain can't think.
5. **Plain language everywhere the user looks.** No "classification / suppressed / noise / 50%" on any primary surface. That jargon is a power-user drawer, translated into human sentences.
6. **Ask is omnipresent.** A floating "Ask Flow" bar sits at the bottom of every screen. One keystroke to a grounded answer.
7. **Guide the empty states.** Nothing is ever just blank — every empty state points at the next action.

## The state machine (the Home screen renders by state)

The dashboard is primarily ONE page that changes shape based on where the project
is. Four states:

### State 0 — Cold · no OpenRouter key
A single focused, full-screen card. Everything else is hidden.
> **"Flow needs a brain."**
> Flow uses an LLM to understand your code and conversations. Paste your OpenRouter key to begin.
> `[ sk-or-… ]  [ Connect ]`   · link: *where do I get one?*

On submit → **validate live** (a real test call). Spinner → ✓ "Brain online." A
brief, satisfying transition → State 1. On failure → inline, human error ("That
key was rejected by OpenRouter — check it and try again").

*This directly fixes what you hit: you could never reach GitHub without the key, and the key ask is the first and only thing on screen.*

### State 1 — Empty brain · key set, no sources
The connect surface becomes the hero.
> **"Your brain is empty. Connect a source to start."**
> A row of large, friendly source cards:
> - **GitHub** — "Pick repositories to understand." → repo picker (gh CLI / PAT)
> - **Linear** — "Sync tickets & context." → paste key
> - **Fireflies** — "Bring in meeting decisions." → paste key
> - **Meeting notes** — "Paste a transcript." → textarea
>
> Slack shows locked in local mode ("Always-on — available once deployed").

Connect one → immediately State 2.

### State 2 — Building · sources connected, indexing
The graph appears and **grows live**, center stage. Above/beside it, a **"Now
indexing"** panel:
> 🟢 **api-service** — reading… 34 facts so far
> ⚪ **web-app** — queued

Nodes pop into the graph as they're written. The user watches their brain form.
This is the emotional core of the product.

### State 3 — Alive · the steady state
The graph is the hero, center. Around it:
- **Sources** rail — each connected source with its live sync status ("✓ up to date", "catching up…") and an **+ add source** button.
- **Brain stats** — quiet confidence: "1,240 facts · 3 sources · updated 2m ago."
- **Recent activity** (humanized, small) — "Indexed api-service · +34 facts", "Learned from #eng thread".
- The floating **Ask Flow** bar.

## The persistent frame (always present, State 1+)

- **Top bar:** project name · mode badge (LOCAL/PROD) · brain size ("1,240 facts from 3 sources").
- **Floating Ask Flow bar** (bottom center): always there. Type a question → slide into the Ask view.
- **A quiet menu** (not loud tabs) for the secondary surfaces: Sources, Settings, Activity, Automations (permissions). The *primary* experience is the Home canvas + Ask bar — these are drawers you open when you need them, not the front door.

## The Ask view

Triggered by the floating bar from anywhere.
- The **answer** takes center attention — clean, readable, with confidence shown as a plain phrase ("high confidence" not "0.82").
- The **graph beside it highlights the exact nodes used** to answer — you *see* the ground truth light up. This is the "feel the brain" moment.
- **Citations** as friendly chips: `api-service · auth.ts:44`, `#eng thread`.
- The Ask bar stays; follow-ups continue the thread.

## The brain (graph visualization) — the hero component

- **Grows live** during indexing — nodes animate in as they're written to the graph.
- **Grouped & colored by type** (services, capabilities, APIs, resources, concepts) with a simple legend.
- **Sources are visible** — you can see which cluster came from which repo/source ("this neighborhood is api-service").
- **Click a node** → a plain-language card: what it is, its description, where the evidence is.
- **Not a hairball** — sensible force layout, zoom/pan, filter by type or source, and it starts focused on the important nodes rather than dumping everything.
- When highlighting an answer, non-relevant nodes dim so the used subgraph stands out.

## Humanizing the language (fixes the "noise / suppressed" screenshot)

The Activity/audit surface stays for power users but is translated. Never show raw
taxonomy on a primary surface. Examples:

| Internal (today) | What the user sees |
|---|---|
| `noise · suppressed · 50%` | *(hidden — noise isn't shown at all)* |
| `knowledge_claim · graphwrite · ok` | "Learned a fact from #eng" |
| `index_job · ok` | "Indexing api-service" |
| `task_discussion · propose` | "Suggested a Linear ticket — review" |
| `repo_added · index_job` | "Connected api-service — indexing now" |

Activity is a *timeline of things Flow did for you*, in sentences — not a database table.

## What this is NOT (scope guard)

- Not the multi-project control plane (one dashboard managing all projects) — that stays "Later" per prior decision. This is the single-project experience, done right.
- Not a redesign of every internal page — Settings/Activity/Automations get humanized but the focus is the **primary journey**: cold → key → connect → watch it build → ask.

## Build plan (once approved)

1. **State machine + Home canvas** — the `/` page renders State 0–3 from `GET /v1/mode`, `GET /v1/settings` (is the key set?), `GET /v1/repos` + `/v1/ingest/status` (sources & indexing), and graph size. The gating that makes the key the first and only thing.
2. **OpenRouter key gate** — State 0 card with live validation (a cheap test call through the settings API).
3. **Live brain** — the graph front-and-center, growing from a `/v1/graph/overview` feed + poll; node-pop animation during indexing.
4. **Now-indexing panel** — from `/v1/ingest/status` + job status, humanized.
5. **Floating Ask bar + Ask view** — omnipresent bar → answer page with highlighted subgraph.
6. **Humanized Activity** — translation layer over the audit log; drop noise entirely.
7. **Quiet menu** — demote Settings/Activity/Automations from loud tabs to a menu; Home + Ask are the front door.

Each ships behind the same verify-all gate; the graph/answer data paths are proven
against the live orchestrator before we call any of it done.

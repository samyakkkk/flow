# Knowledge pipeline benchmark

End-to-end quality harness for the memory + docs pipeline: scripted sessions
and Slack/Linear corpus fixtures with **planted ground truth**, pushed through
the real pipeline (distiller LLM → consolidation judge → dedupe sweep → docs
composer → retrieval), then scored by an LLM judge.

This answers, with numbers, the questions a team actually has:

- does a session's durable knowledge become memories (**recall**), and only
  that (**precision**)?
- does the **user's context** survive — rationale, rejected alternatives,
  meta-preferences, product north stars, roadmap intent? (`intent-channel
  recall` — the metric the v1 prompt failed)
- do forbidden things stay out — session trivia, ruled-out hypotheses,
  **fabricated user rules** (permission denials ≠ preferences), **secrets**?
- does the same fact learned twice end up as **one** memory?
- does a stale claim get **contested** when the user states the opposite?
- do realistic queries (verbatim symptom, paraphrase, task-shaped) **surface**
  the right memory or corpus row?
- are the composed **docs** honest — citations valid, every fact covered,
  nothing fabricated?

## Run

```sh
# from the repo root — real LLM calls (claude CLI) + live-gateway embeddings
node --import tsx/esm benchmarks/knowledge/run.mjs

# without a running flow gateway (deterministic hash embeddings)
node --import tsx/esm benchmarks/knowledge/run.mjs --stub-embed

# keep the scratch DB for inspection
node --import tsx/esm benchmarks/knowledge/run.mjs --keep-db
```

Takes ~20–30 minutes and spends real LLM calls (a few dozen sonnet distills +
composer calls, ~100 haiku judge/match calls). **Deliberately not wired into
CI** — this is a proof harness, re-run when the distiller prompt,
consolidation, or docs composer change materially.

Reports land in `results/report-<timestamp>.{md,json}` (gitignored).

## Fixtures

- `fixtures/sessions.json` — 12 scripted sessions over a synthetic
  `acme-checkout` project. Each carries `expected` facts (gist + kind +
  provenance; `intent: true` marks the user-context channel) and `forbidden`
  extractions. Scenarios: rationale-bearing decision, meta-preference,
  error-proven gotcha, pure lookup (expects zero), ruled-out hypothesis,
  permission-denial (must not fabricate a user rule), duplicate pair,
  contradiction against a preseeded stale memory, secret redaction, roadmap
  plan, UX north star.
- `fixtures/corpus.json` — Slack decisions + a Linear ticket (evidence tier:
  searchable, never consolidated).
- `fixtures/queries.json` — 2–3 realistic phrasings per planted fact.

## Relation to flow-benchmarks

`flow-benchmarks/memory-evals` calibrates the distiller prompt against
**recorded production transcripts** with human grades. This harness is the
complement: synthetic, self-contained, whole-pipeline, and runnable by anyone
from the repo — it versions with the code it measures.

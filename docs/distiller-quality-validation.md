# Distiller requirement-retention follow-up

Captured Cursor and Copilot sessions reached the server intact and completed
extraction, but their model responses were valid empty arrays. The failure
preceded parsing, storage, consolidation and retrieval. Existing live examples
from other clients still extracted, so a provider outage was not established.

Read-only replays showed that removing repository metadata, removing the earlier
orientation turn, separating system/user messages, or adding one explicit rule
did not rescue the Cursor requirement. A direct requirement-classification
request recognized the same text as durable. The shorter prompt in this change
preserves explicit requirements and rationale while retaining exclusions for
routine actions, progress, generic advice, abandoned conclusions and secrets.
This comparison supports changing the selection instructions; it does not
identify one original sentence as the sole cause.

The paid, opt-in replay is:

```sh
node --import tsx/esm scripts/check-distiller-quality.mjs
```

Supply OPENROUTER_API_KEY through the environment. DISTILLER_EVAL_MODEL optionally
overrides the default tested model, anthropic/claude-sonnet-4.6. The script sends
sanitized fixtures to OpenRouter and never writes Flow memories or transcripts.

On 2026-09-06, all 11 cases passed: five captured requirement sessions, a user
preference, a corrected decision, and four negative controls. All 85 memory
unit/integration tests also passed. The checker enforces parseability, observation
bounds, expected concepts and zero observations for negative controls. These
coarse assertions and a small fixture set do not establish population-level
precision. Initial replay claims were manually reviewed for relevance and final
conclusions. A fresh native-client capture/extraction/retrieval run on the isolated
cloud deployment is still required before calling the integration fixed.

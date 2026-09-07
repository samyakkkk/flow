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
conclusions.

On 2026-09-06 at 05:38 UTC, fresh native Cursor and Copilot sessions on the
isolated cloud deployment each produced two stored observations through the
normal `maybeDistill` pipeline, manually triggered at the user's request before
the idle deadline. The originating sessions made no direct memory writes.
Their observations consolidated into existing memory
`e54bf0c7-c785-4af9-b792-25835de6dfe2`. A fresh Codex session retrieved that memory
and its five linked evidence records using only Flow MCP orient, search_knowledge
and get_entity, without local reads or shell commands. Search returned no 401.
This validates capture, extraction, storage and retrieval with a manual trigger;
it does not validate the idle timer in this run or create a new memory ID.

The retrieved consolidated headline still omits the selected executable version
present in the new observations, and its card reports two contradictions. Thus
this check demonstrates requirement retention, not lossless consolidation or
perfect memory quality. Evidence: ignored local log
`data/codex-final-cursor-copilot-retrieval.jsonl`.

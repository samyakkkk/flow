# Index Workspace

Connect repositories one at a time; the knowledge graph updates as they land.

```bash
# prerequisites: graph-gateway running (cd ../graph-gateway && npm run dev),
# FalkorDB container up, opencode installed with a provider connected

# connect a repo (clones prod branch, registers it, indexes it into the graph)
node scripts/add-repo.mjs <git-url> [branch]

# bring everything up to date (pull all repos; full-index new ones,
# incremental-index ones with new commits, skip unchanged) — cron-safe
node scripts/update.mjs [repo-name]
```

- `repos.json` tracks connected repos and their last indexed commit. A failed
  run leaves `lastIndexedCommit` untouched, so the next update retries it.
- Indexing runs as the `graph-builder` opencode agent (`.opencode/agents/`),
  which writes through the graph-gateway `graph_*` tools — find-before-create
  dedup is what keeps later repos enriching earlier ones instead of
  duplicating them. Those tools import `@opencode-ai/plugin`; the dependency
  is declared in `.opencode/package.json` and `flow up` installs it into each
  project workspace (do not rely on OpenCode's background install alone).
- Model: `GRAPH_BUILDER_MODEL` env var, default `opencode/claude-sonnet-4-6`.
- Watch what the builder writes live: `curl -s localhost:7433/v1/journal | jq`
  or `tail -f ../graph-gateway/data/journal.jsonl`.

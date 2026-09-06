# Verifying source from repositories absent locally

Flow's `source_read` and `source_search` MCP tools read committed source on the
Flow host. Coding agents need no local clone. Use a registered repository name,
a repository-relative file path or literal query, and optionally a full commit
SHA. The default revision is `lastIndexedCommit`; when no indexed commit exists,
HEAD is returned with an explicit `different_or_unindexed_revision` marker.
Every response includes the resolved SHA and indexed SHA, so callers can tell
whether a graph claim and source evidence describe the same revision.

Example:

```json
{"repo":"payments","path":"src/refunds.ts","start_line":30,"end_line":80}
```

Use `source_read` for that request, or search first with `source_search`:

```json
{"repo":"payments","query":"refundPayment","limit":20}
```

The tools return data rather than executing instructions in source files.
They never clone arbitrary URLs, expose a shell, read untracked/dirty files,
or follow file symlinks/submodules. Reads are bounded to 200 lines and 256 KiB
files; searches to 50 results, 256 KiB Git output and a five-second subprocess
timeout. Large searches may return a limit error rather than partial results.

## Authorization and deployment

The HTTP MCP endpoint authenticates the personal token and checks the user's
project grant. Source access inherits that project permission: this version
does **not** introduce per-user ACLs within a project. Only code repositories
registered in that project's `workspace/repos.json` are eligible. An admin can
set `sourceRead: false` on a registry entry to exclude it from source tools.
Do not register repositories in a project whose members should not read them.

Flow resolves remote repositories to its managed `workspace/repos/<name>`
clone, not the user's work checkout. Local-only registrations use their declared
`localPath`. The configured path must itself be a Git repository root; a missing
clone never falls back to an enclosing repository. Deleting a registration or
revoking the project grant removes access on subsequent calls (subject to the
existing short auth cache). Raw Git failures are sanitized to avoid disclosing
server filesystem paths.

`flow up` supplies `FLOW_SOURCE_REGISTRY` to gateway and orchestrator processes.
Local connector setup stores that path in private machine config; remote
clients receive neither the registry path nor a server checkout path. Update
Flow, restart the isolated deployment and rerun local setup to install the new
source tools/instructions. Cloud stdio bridges discover the server's tool list
at startup, so restart the client connection after updating the server.

A full SHA can select another commit present in the registered repository.
This is historical source access under the same project permission, not a
restriction to only the indexed snapshot. The response identifies revision
mismatches instead of silently presenting newer code as indexed evidence.

# Flow integration boundary

T3's upstream applications and package layout remain at the repository root.
Keep host-specific changes in `apps/server/src/brain` and
`apps/web/src/components/brain`; provider, HTTP and project integration should
call those adapters rather than importing Flow internals themselves.

`shared/` is the canonical Flow Brain implementation for local and cloud hosts.
The gateway, orchestrator, prompts and their tests were copied from `flow/`
without replacing their algorithms. `flow/` remains a historical migration
reference and is not used by the T3 build. Make future Brain changes in `shared/`.
Original licenses remain attached to the shared implementation.

The local host owns one native FalkorDB process and one embedding service.
Each Brain gets its own graph and memory SQLite store. Session and indexing
workers borrow the same database socket and embedding endpoint; invalid resource
configuration is rejected instead of starting another model or falling back to
an unrelated database. No Flow CLI, Docker, or `flow up` is required.

`cloud/` contains the public connection interfaces. Authentication, provisioning,
billing and private deployment implementations belong in the private repository.
Cloud can depend on the shared Brain packages without importing T3 UI or provider
code. The remote interface does not imply remote hosting is implemented locally.

T3 packages its Brain worker and original indexing assets into the server build;
the desktop app includes that server. Source checkout developers install the
workspace lockfile after pulling dependency changes. End users must not need to
install these packages manually.

Merge upstream T3 commits into the integration branch without moving or renaming
upstream files. Resolve the small adapter registration points when upstream APIs
change, then run the focused Brain/provider tests and packaged-worker test.
Do not replace Flow behavior to make an upstream merge easier.

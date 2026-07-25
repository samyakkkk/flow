# Flow — Test deployments

How to run one or more isolated Flow deployments (a branch under test, a
release candidate, a scratch install) alongside your main `flow` — without
either one stepping on the other's ports, data, or graph store.

For the one-time environment setup itself see `../setup.sh --help`; for the
architecture behind projects/ports see `ARCHITECTURE.md`.

## The model

`setup.sh --alias <name>` registers an independent checkout under
`~/.flow/checkouts/<name>` with its own launcher command on PATH. Each alias
is fully self-contained: own deps, own `data/` (projects, auth, logs, pids).

Isolation of the *runtime* is driven by env baked into the alias's launcher —
you never export anything by hand:

| Flag | Env baked into the launcher | Effect |
|---|---|---|
| `--port-offset <n>` | `FLOW_PORT_OFFSET=<n>` | Shifts every service port: gateway `7433+n`, orchestrator `7500+n`, dashboard `7600+n` (`bin/lib/ports.mjs`) |
| `--fresh-db` | `FALKOR_PORT`, `FALKOR_CONTAINER` | Launches this alias's OWN FalkorDB container (`flow-falkordb-<alias>`) on `6379+offset` (6479 if no offset) |
| `--falkor-host <h>` | `FALKOR_HOST=<h>` | Points at an existing/remote FalkorDB; Flow never touches Docker |
| `--falkor-port <p>` | `FALKOR_PORT=<p>` | With `--fresh-db`: which port to launch on. With `--falkor-host`: which port to dial |

Every service inherits these because `flow up` spawns with
`{ ...process.env, ... }` (`bin/flow.mjs` spawnService) and the FalkorDB
provisioner reads `FALKOR_*` at import (`bin/lib/docker.mjs`).

## Recipes

**Fully isolated test deployment** — own ports, own fresh graph store:

```bash
./setup.sh --alias t1 --branch feat-x --port-offset 1000 --fresh-db
t1 up testco        # dashboard → http://localhost:8600/testco
```

**Isolated services, shared FalkorDB** — reuses the default `:6379` container;
named graphs isolate projects, so use a project name your main deployment
doesn't:

```bash
./setup.sh --alias t2 --branch feat-y --port-offset 2000
t2 up testco2       # dashboard → http://localhost:9600/testco2
```

**External / remote FalkorDB:**

```bash
./setup.sh --alias t3 --branch feat-z --port-offset 3000 \
  --falkor-host 10.0.0.5 --falkor-port 6390
```

Re-running the same `setup.sh` command later updates the checkout in place
(fetch + checkout + `pull --ff-only`) and regenerates the launcher — that's
also how you change an alias's configuration.

## Rules that keep deployments from colliding

- **Always pass `--port-offset` for a second deployment.** Without it, both
  compute the same port triplet and `flow up` in one kills the other's
  services (each `up` sweeps its own computed ports first).
- **Pick offsets ≥ 1000 apart.** Ports stride by 10 per project inside a
  deployment, so nearby offsets can still overlap once a deployment has
  several projects.
- **Shared FalkorDB ⇒ distinct project names.** The graph name defaults to
  the project name (`bin/flow.mjs` createProject), so two deployments sharing
  `:6379` with the same project name read/write ONE graph.
- **`t1 down` stops a `--fresh-db` container; `t1 up` restarts it.** This is
  testing-only behavior, keyed off the `FALKOR_CONTAINER` env only a
  `--fresh-db` launcher bakes in — it marks the deployment as the container's
  sole owner. It fires only on a whole-deployment `t1 down` (a single-project
  `t1 down <name>` leaves the DB serving the alias's other projects, same rule
  as the dashboard). The container is *stopped*, not removed, so graph data
  survives the down/up cycle. The default shared `flow-falkordb` container is
  substrate for every deployment on the machine and is never touched by
  `down`, fresh-db or not.

## Removing a test deployment

```bash
t1 down                                # stops services + its fresh-db container
docker rm -f flow-falkordb-t1          # destroy the container + its graph data
rm -rf ~/.flow/checkouts/t1            # checkout + all its data/
rm ~/.local/bin/t1                     # the launcher (path shown at setup)
```

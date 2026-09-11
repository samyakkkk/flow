# Troubleshooting

First stop: `flow doctor` prints a health summary, and every service logs to
`data/projects/<name>/logs/{gateway,orchestrator,dashboard}.log`.

- **`npm install` fails on an old Node, or with a SQLite build error** — Flow needs **Node 22+**. `nvm install 22 && nvm use 22`, then `npm install` again. (On 22+, SQLite installs a prebuilt binary — no C/C++ toolchain required.)
- **`flow up` says a dependency "was built for a different Node version"** (or the orchestrator log shows `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED`) — a leftover from an install attempt on another Node is shadowing the fresh install. Clean reinstall from the flow directory: `rm -rf node_modules orchestrator/node_modules graph-gateway/node_modules dashboard/node_modules && npm install`.
- **`flow up` says Docker isn't installed / the daemon isn't running** — start Docker Desktop and re-run. Prefer no Docker? Run FalkorDB yourself and point Flow at it: `FALKOR_HOST=<host> FALKOR_PORT=<port> flow up`.
- **Port 6379 already in use** — another Redis/FalkorDB holds it. Free it, or reuse that instance with `FALKOR_HOST` / `FALKOR_PORT` as above.
- **"Unable to find image 'falkordb/falkordb:latest'" / image download fails** — the first-run image pull failed. `flow up` prints the real cause; if it mentions a rate limit, `docker login` (a free Docker Hub account raises the anonymous pull limit) or wait an hour. Otherwise check connectivity/VPN and re-run `flow up`.
- **A service "didn't start"** — read the logs above, and run `flow doctor` for a health summary.
- **Index jobs fail with "opencode CLI not found on PATH"** — no coding CLI is installed. Re-run the installer (`curl -fsSL https://www.flow.engineer/install.sh | bash` — it installs opencode via Homebrew / the official installer), or install Claude Code or Codex yourself. Flow never falls back to the npm-bundled opencode binary — it ships unsigned and macOS kills it at exec.
- **`tsx` (or another dev dependency) missing after `npm install`** — check for `NODE_ENV=production` in your shell; it makes npm skip devDependencies. `NODE_ENV=development npm install --include=dev` fixes it.
- **Connecting a repo fails** — cloning needs `git` on your PATH.
- **"still starting up" when you save your key** — the orchestrator takes a few seconds on first boot; wait and retry.
- **Don't `docker compose up` for local dev** — use `flow up`. The compose file under `deploy/` is an experimental full-container path, not the local one.

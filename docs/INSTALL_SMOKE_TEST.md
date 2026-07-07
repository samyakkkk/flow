# Cold-install smoke test

Proves a **fresh machine** can install Flow — the thing we can never verify on a
dev box, because dev boxes already have toolchains, caches, and a system
opencode. Run it after any change to dependencies, `engines`, `bin/flow.mjs`,
`bin/lib/docker.mjs`, or install docs.

**Runner:** any machine with Docker. Every check runs inside disposable
containers, so nothing on the host is touched. Total time ≈ 5–10 min.

**What "pass" means:** every checkpoint below prints its ✅ condition. Any ❌ is
a release blocker — file it with the full log.

---

## Check 1 — clean install on Node 22, slim image (NO build tools)

`node:22-slim` has no Python/make/g++. If anything tries to compile
(node-gyp), this fails — which is the point: install must be prebuilt-only.

```bash
docker run --rm node:22-slim bash -lc '
  set -e
  apt-get update -qq && apt-get install -y -qq git >/dev/null
  git clone --depth 1 https://github.com/samyakkkk/flow.git /flow
  cd /flow
  echo "--- npm install (fresh, no toolchain) ---"
  npm install --no-audit --no-fund 2>&1 | tee /tmp/install.log
  echo "--- CHECKPOINT 1a: no source compile happened ---"
  ! grep -qiE "node-gyp|gyp ERR|make: |g\+\+" /tmp/install.log && echo "✅ no compile"
  echo "--- CHECKPOINT 1b: better-sqlite3 loads and runs ---"
  node -e "const D=require(\"better-sqlite3\");const db=new D(\":memory:\");db.exec(\"create virtual table f using fts5(x)\");db.prepare(\"select 1 as ok\").get();console.log(\"✅ sqlite prebuilt OK\")"
  echo "--- CHECKPOINT 1c: bundled opencode binary runs ---"
  node_modules/.bin/opencode --version && echo "✅ opencode bundled OK"
  echo "--- CHECKPOINT 1d: flow CLI parses and prints help ---"
  node bin/flow.mjs --help >/dev/null && echo "✅ flow CLI OK"
'
```

Expected: all four ✅ lines. Watch 1a closely — a `better-sqlite3` or other
native-dep regression shows up here first.

## Check 2 — Node 20 is refused up front, before any dependency scripts

Two layers: `.npmrc engine-strict=true` makes npm itself refuse (`EBADENGINE`
"Unsupported engine") before ANY dependency install script runs, and the
`preinstall` guard prints the `nvm install 22` fix on runners that skip engine
checks. Either message passes; a node-gyp/compile wall in the log FAILS —
that's the confusing-death mode this check exists to prevent.

```bash
docker run --rm node:20-slim bash -lc '
  apt-get update -qq && apt-get install -y -qq git >/dev/null
  git clone --depth 1 https://github.com/samyakkkk/flow.git /flow
  cd /flow
  npm install --no-audit --no-fund > /tmp/i.log 2>&1
  RC=$?
  if [ $RC -ne 0 ] && grep -qE "Unsupported engine|EBADENGINE|Flow needs Node 22" /tmp/i.log \
     && ! grep -qE "node-gyp|gyp ERR" /tmp/i.log; then
    echo "✅ Node 20 refused up front (no dependency scripts ran)"
  else
    echo "❌ guard failed — install did not stop cleanly/early:"; tail -30 /tmp/i.log
  fi
'
```

## Check 3 — `flow up` fails helpfully when Docker is unavailable

Inside a container there is no Docker daemon and nothing on 6379 — exactly a
fresh laptop without Docker Desktop. `flow up <name>` must print the friendly
"Docker isn't installed… Install Docker Desktop… or FALKOR_HOST=…" guidance,
NOT a raw stack trace. (stdin is not a TTY, so create the project first.)

```bash
docker run --rm node:22-slim bash -lc '
  set -e
  apt-get update -qq && apt-get install -y -qq git lsof >/dev/null
  git clone --depth 1 https://github.com/samyakkkk/flow.git /flow
  cd /flow && npm install --no-audit --no-fund >/dev/null 2>&1
  node bin/flow.mjs project create smoketest >/dev/null
  node bin/flow.mjs up smoketest > /tmp/up.log 2>&1 || true
  echo "--- flow up output ---"; cat /tmp/up.log
  if grep -q "Docker isn.t installed" /tmp/up.log && grep -q "FALKOR_HOST" /tmp/up.log; then
    echo "✅ friendly Docker guidance"
  else
    echo "❌ expected friendly Docker message, got the above"
  fi
  ! grep -qE "^\s+at .*\(.*:[0-9]+:[0-9]+\)" /tmp/up.log && echo "✅ no stack trace" || echo "❌ stack trace leaked"
'
```

## Check 4 — full boot with a real FalkorDB (closest to `flow up`)

Run FalkorDB as a sibling container and point the Flow container at it — this
exercises the new "FalkorDB already reachable → skip Docker" path AND boots all
three services for real. The dashboard build is the slow step (~1–2 min).

```bash
docker network create flow-smoke 2>/dev/null || true
docker run -d --rm --name smoke-falkor --network flow-smoke falkordb/falkordb:latest
docker run --rm --network flow-smoke -e FALKOR_HOST=smoke-falkor node:22-slim bash -lc '
  set -e
  apt-get update -qq && apt-get install -y -qq git lsof procps >/dev/null
  git clone --depth 1 https://github.com/samyakkkk/flow.git /flow
  cd /flow && npm install --no-audit --no-fund >/dev/null 2>&1
  node bin/flow.mjs project create smoketest >/dev/null
  node bin/flow.mjs up smoketest 2>&1 | tee /tmp/up.log
  grep -q "ready" /tmp/up.log && echo "✅ project came up (gateway+orchestrator+dashboard healthy)" || { echo "❌ boot failed — logs:"; tail -40 data/projects/smoketest/logs/*.log; exit 1; }
  echo "--- CHECKPOINT 4b: dashboard serves the login/home page ---"
  curl -s -o /dev/null -w "%{http_code}" http://localhost:7600/login | grep -qE "200|30." && echo "✅ dashboard responds"
  echo "--- CHECKPOINT 4c: doctor is green ---"
  node bin/flow.mjs doctor 2>&1 | tee /tmp/doc.log; grep -q "pages + assets OK" /tmp/doc.log && echo "✅ doctor green"
'
docker rm -f smoke-falkor; docker network rm flow-smoke
```

Note: `curl` may be missing on slim — use
`node -e "fetch('http://localhost:7600/login').then(r=>{console.log(r.status);process.exit(r.status<500?0:1)})"`
instead if so.

## Check 5 — Linux x64 AND arm64 (if the runner is Apple Silicon)

Prebuilt-binary coverage is per-platform. On an arm64 Mac, Docker runs arm64
images by default; add one x64 pass for Check 1 to cover Linux servers:

```bash
docker run --rm --platform linux/amd64 node:22-slim bash -lc '<Check 1 body>'
```

(Slower under emulation — only Check 1 is needed for the second arch.)

---

## Report format

For the hand-back, report a table: check | platform | result (✅/❌) | note,
plus the tail of any failing log. If everything passes, say so plainly — that's
the green light that a stranger's `git clone && npm install && flow up` works.

## Known limits of this test

- It does not test macOS hosts (containers are Linux). macOS is lower-risk for
  the failure modes covered here (prebuilds exist for darwin-x64/arm64), but a
  volunteer with a clean Mac is still the gold standard.
- Check 4 boots services but doesn't index a repo or run Ask (needs an
  OpenRouter key). Onboarding past the key gate is covered by `flow doctor` +
  the dashboard's own verification flows.

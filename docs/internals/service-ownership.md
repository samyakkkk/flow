# Service ownership

One persistent local service owns a data home. The desktop app, the `flow` CLI, a browser,
and the coding-CLI hooks of external agent sessions are all clients of it. This page covers
what "owner" means, what a service manager needs from the supervisor, and the two things a
change here can break silently: a moved data home, and a client that guesses compatibility.

## One owner, many clients

The owner is the server the [supervisor](../../scripts/instances/supervisor.mjs) runs for an
instance. A second owner of the same data is not a policy but an impossibility, enforced
twice: `instance-lock.sqlite` holds an exclusive SQLite transaction for the process lifetime
([`instanceOwnership.ts:20-62`](../../apps/server/src/instanceOwnership.ts)), and the brain
takes a directory-as-mutex `owner.lock` carrying the owner's pid
([`BrainRuntime.ts:431-458`](../../apps/server/src/brain/BrainRuntime.ts)). Chat and brain run
together in one server; a client that cannot reach the owner must surface that, not start a
second one.

Discovery follows the same rule. [`discoverService`](../../scripts/instances/service-discovery.mjs)
reads the instance's `config.json` and `runtime.json` and probes the control API, and never
starts, stops, migrates, or repairs anything — an unreachable owner is not permission to start
another server (`service-discovery.mjs:24-25`). It also never forwards the control token or
URL to a caller; those belong to the lifecycle owner (`:114-116`).

External coding CLIs care most about the owner staying up. A hook reads
`<stateDir>/brain-endpoint.json` per call rather than the server's RPC surface
([`capture-replay.mjs:11-22`](../../flow-t3/shared/bin/harness/capture-replay.mjs)). That file is
written with a fresh port and token when the shared brain transport starts and removed when it
stops ([`shared-runtime.ts:216-241`](../../apps/server/src/brain/shared-runtime.ts)): per-boot
state, never a durable address, so nothing may cache it across a restart. While it is absent,
hooks spool to disk and the next owner drains the spool on its 5 s replay interval
(`shared-runtime.ts:224-233`). Downtime costs latency, not data — which is why the service
outliving the desktop window matters: agent sessions keep capturing with no app open.

## The service manager contract

The unit runs `node scripts/flow.mjs --supervise <instanceDir>` directly
([`service.mjs:37-56`](../../scripts/instances/service.mjs)). It does not run `flow`: the
launcher spawns a detached supervisor and exits, which launchd or systemd would read as a crash
and respawn forever.

With `KeepAlive = { SuccessfulExit: false }` on macOS and `Restart=on-failure` on Linux, the
exit code is the only channel the supervisor has for telling intent from failure
([`supervisor.mjs:58-61`](../../scripts/instances/supervisor.mjs)). Every exit picks one
deliberately:

| Exit | Cause                                                         | Manager                           |
| ---- | ------------------------------------------------------------- | --------------------------------- |
| 0    | `POST /stop` (`flow stop`), `supervisor.mjs:195`              | stays stopped                     |
| 0    | managed release selection failed, `supervisor.mjs:77-88`      | stays stopped — needs reinstall   |
| 0    | `supervisor-lock.sqlite` already held, `supervisor.mjs:92-98` | stays stopped — an owner exists   |
| 1    | an owned child exited unexpectedly, `supervisor.mjs:225-231`  | restarts after `ThrottleInterval` |
| 1    | readiness deadline or startup error, `supervisor.mjs:334-346` | restarts                          |

A failure lingers ~2 s before exiting (`supervisor.mjs:165-170`) so `/status` can still answer
the `flow` command polling it. Adding an exit path means choosing a column in that table — under
plain `KeepAlive=true` none of these are distinguishable, `flow stop` would not stick, and a crash
loop would be silent.

Managed mode is one env var. `FLOW_SERVICE_MANAGED=1`, set by the unit
(`service.mjs:74`), makes the auto-update restart path stop and exit 1 instead of spawning a
detached replacement (`supervisor.mjs:103-109`): a self-spawned successor would race the service
manager for `supervisor-lock.sqlite`. For the same reason a start or `flow restart` under a
managed unit goes through `launchctl kickstart` / `systemctl --user restart` rather than starting
a supervisor itself (`service.mjs:145-153`, dispatched at `launcher.mjs:217`).

`T3CODE_HOME` is deliberately absent from the unit's environment (`service.mjs:57-58`). The
supervisor sets it per child from the instance's recorded home (`supervisor.mjs:267`), and
`cleanEnvironment` strips an inherited one (`supervisor.mjs:48-57`). A home in the unit would
be a second, stale answer to a question `config.json` already owns.

The plist and systemd renderers in [`service-unit.mjs`](../../scripts/instances/service-unit.mjs)
are plain-JS siblings of [`bootService.ts`](../../apps/server/src/cloud/bootService.ts), not
imports of it: this bootstrap layer must not depend on the Effect server package, and
`bootService` installs the separate T3 Cloud boot service with its own label. Flow's is
`com.flow.service` / `flow.service` (`service.mjs:16-17`), so the two never collide.

## Data homes are never moved

The home a service owns is recorded once in the instance `config.json` and honored verbatim
forever after ([`launcher.mjs:151-157`](../../scripts/instances/launcher.mjs)); passing a
different `--home` to an existing instance is an error, not a migration (`launcher.mjs:125-126`).
Discovery treats the recorded home as the service's identity and only disqualifies it when the
directory is gone, because discovery must never invent a home it did not find
(`service-discovery.mjs:56-63`). `flow service uninstall` removes the unit and touches no data
(`service.mjs:175`).

The default for a _new_ home is the rule in
[`homeBaseDir.ts`](../../packages/shared/src/homeBaseDir.ts): an explicit `T3CODE_HOME` or
`--base-dir` wins, else `~/.t3` when `~/.t3/userdata` already exists, else `~/.flow`. Existing
installs are adopted where they are. The rule is a pure function and callers do the probe I/O,
because its sites have incompatible filesystem stories (Effect `FileSystem`, Electron's pre-ready
sync reads, plain Node scripts).

This is the part that is easy to get wrong, so state it plainly: **relocating an existing home
is destructive, and a `mv` does not even touch most of the damage.**

1. **The brain's storage is outside the tree and keyed by the old path.** FalkorDB data lives
   at `~/.flow-brain/<sha256(brainDir)[0:12]>`, hashed from the verbatim absolute
   `<stateDir>/brain` string (`BrainRuntime.ts:156-164`), a workaround for macOS's 104-byte
   Unix socket limit. A moved home hashes to a different directory, so the server comes up with
   an empty graph and the real one orphaned — no error, no relocation logic. `owner.lock` lives
   in there too (`BrainRuntime.ts:431-457`).
2. **Managed git worktrees hold absolute pointers.** Worktrees under `worktreesDir`
   (`GitVcsDriverCore.ts:728,2876`) and brain workspace clones under the state directory store
   absolute `gitdir:` paths in both directions. Moving the tree breaks every one of them until
   `git worktree repair` runs from each source repository — and checkpoint refs live in those
   trees.
3. **Binding identity is derived from the state directory.** A bound folder's project key is
   `agents-<hash(stateDir + ':' + brainId)>`
   ([`resolve.mjs`](../../flow-t3/shared/bin/harness/resolve.mjs)), and the machine registry
   lists the state directories it may ask about Brains. A new path is a new key, orphaning
   every project's capture spool and every binding in `~/.flow/config.json`. Hook and MCP
   lines in the user's tool configuration carry no project and survive a move, but they are
   trust-hashed by Codex and must never change
   ([`materialize.mjs`](../../flow-t3/shared/bin/lib/materialize.mjs), `hookCmd`).

Absolute paths are persisted in the event log and provider settings too, so a projection rebuild
would not repair them either. A move, if ever genuinely required, is a migration project with a
journal, not a rename.

`~/.flow` is also the agent registry's home, so its T3 subdirectories must never be mistaken for
registry leftovers; managed-worktree detection matches both layouts
(`AgentSessionScanner.ts:561`).

## Compatibility is a protocol generation, not a version

`ExecutionEnvironmentDescriptor` carries an optional `desktopProtocol`
([`environment.ts:154-171`](../../packages/contracts/src/environment.ts)), served unauthenticated
from `/.well-known/t3/environment` and emitted by
[`ServerEnvironment.ts:215`](../../apps/server/src/environment/ServerEnvironment.ts). It is a
generation, not a build version: bump it only when an attaching desktop and the server can no
longer agree on the credential handshake or the attach contract. A new capability is an optional
capability key instead.

A desktop build supports a `[min, max]` range. **Absent means incompatible**, because an older
server's silence cannot be read as "generation 1" — guessing here would attach a client to a
server that never agreed to the contract. Recovery is [the attached backend's](#the-attached-desktop-backend) job, not this contract's.

## Credentials for a trusted local client

There is no control-API `/attach` endpoint and should not be one. `t3 pair`
([`pair.ts`](../../apps/server/src/cli/pair.ts)) already mints a credential against a _running_
server with no cooperation from it: a second same-user process opens the shared auth database and
calls `createPairingLink`. The trust boundary is the filesystem — whoever can read that database
already owns the data — so an attach endpoint would add network surface without adding proof.
`flow` itself pairs this way after a launch (`launcher.mjs:237-250`).

The desktop reuses that path — it runs the service's own backend entry as
`pair --base-dir <dataHome> --admin --json` (`DesktopAttachedBackend.ts:156-202`) — asking for
`AuthAdministrativeScopes` because an attached client still has to manage connections
(`pair.ts:427-446`, flag at `:470-472`). `--admin` widens the scope, not who may ask.

Minting spawns a process, and the bridge that hands the renderer its backend address
(`getLocalEnvironmentBootstraps`) is a _synchronous_ IPC channel: an async Effect inside it is an
uncaught `AsyncFiberError` in the main process. So the attached instance's `currentConfig` carries
no token and stays synchronous, and exposes `mintBootstrapCredential` instead. The renderer never
sees the credential: `DesktopLocalEnvironmentAuth` (the bearer every renderer request carries,
fetched over the async `getLocalEnvironmentBearerToken` channel) mints one there when the config
has none, exchanges it once, and caches the bearer exactly as it does the legacy token.

## The attached desktop backend

[`makeAttachedBackendInstance`](../../apps/desktop/src/backend/DesktopAttachedBackend.ts) is a
second `DesktopBackendInstance` beside `makeBackendInstance` and shares no machinery with it:
nothing is spawned, so there is no restart loop, no output capture, and deliberately no process
`Scope` — `DesktopBackendPool` stops an instance by closing its scope, and an attached instance
holding one would drag the shared service down with the app (`DesktopAttachedBackend.ts:7-13`).
`start` is discover → compatibility check → park-or-attach (`:291-350`), `stop` only clears the
desired-running flag (`:355-359`), and `snapshot` reports no pid, which is how consumers tell "we
own a process" from "we are a client" (`:414-424`). A `starting` service is polled for as long as
the supervisor's own 120 s readiness deadline (`:278-289`), so a slow first boot is never called a
broken service. A failed attach never retries itself: it parks one of four reasons —
`not-installed`, `stopped`, `unreachable`, `incompatible` (`:132-151`) — and the recovery surface
drives the retry through `onPreflightFailed` (`:325-349`). It may offer a retry and an
open-in-browser escape. A `stopped` service is started once per session before the screen appears,
through the service manager when a unit is loaded and otherwise by running the service's own
launcher with the runtime the registry recorded (`config.node`), which takes the launcher and
supervisor locks itself. The desktop never downgrades the service and never spawns a private child server,
which would collide with the owner's locks on the first write. The private child survives behind
`FLOW_DESKTOP_LEGACY_BACKEND=1` for exactly one release as the rollback
([`DesktopBackendPool.ts:364-367`](../../apps/desktop/src/backend/DesktopBackendPool.ts)).

Two constraints only this path knows.

**The desktop discovers in the _release_ registry, never a source checkout's.**
`desktopServiceRegistryRoot` resolves `FLOW_INSTANCE_HOME`, else
`<FLOW_RELEASE_HOME ?? ~/.local/share/flow-browser>/instance-home`
([`serviceDiscovery.ts:54-67`](../../apps/desktop/src/backend/serviceDiscovery.ts)). There is
deliberately no fallback to `launcher.mjs`'s own `~/.local/share/flow-app` default: that registry
belongs to a source checkout, and attaching to it silently would let a dev tree and a release
fight over one app. Attach and first-launch adoption call this same resolver, so the installation
adoption creates and the one attach finds cannot diverge.

**The service the desktop adopts is the independent Flow release bundle**, installed into
`FLOW_RELEASE_HOME` and started through that release's own `flow service install` — never the
desktop's bundled `apps/server/dist/bin.mjs`
([`DesktopServiceAdoption.ts:5-12`](../../apps/desktop/src/backend/DesktopServiceAdoption.ts)).
The release self-updates, so the two update trains stay decoupled: a desktop update cannot move
the service backwards, and a service update need not wait for an app release. That carries a
release-order rule — **a Flow release containing the service layer must be published before a
desktop release that defaults to attached mode**, because adoption runs the published release's
installer, not the code it shipped with.

Adoption journals every step to `<home>/userdata/service-adoption.json` before the next one
starts, and only an `adopted` outcome short-circuits the next launch. A crash or quit mid-adoption
leaves `in-progress` (`DesktopServiceAdoption.ts:89-92`), which deliberately does not count as
adopted: reading it as done would strand a half-installed service the app never finishes, retries
or reports.

**The packaged renderer follows the service, not a port the app chose.** The window loads the
`flow://app` scheme, and that scheme resolves its target on every request from the primary
instance's live address — the attached backend's discovered origin, or a child's origin once it is
ready — never from the port the desktop reserved for a child it no longer spawns
([`ElectronProtocol.ts`](../../apps/desktop/src/electron/ElectronProtocol.ts) `handleDesktopRequest`,
wired in [`DesktopApp.ts`](../../apps/desktop/src/app/DesktopApp.ts)). Resolving per request is what
lets the window follow an attach that completes, or moves, after registration. When there is no
address, requests are served from the web client the artifact already ships at
`<serverRoot>/apps/server/dist/client` inside `server.asar`: the shell for navigations, exact files
for assets, 403 for anything resolving outside that directory, and 503 JSON for `/api`, `/ws`,
`/oauth` and `/.well-known` so a fetch never receives HTML. That fallback is the only reason the
recovery surface can render at all — there is no server to fetch it from — and the address
accessors are plain `Ref` reads.

## Public and private

This repository is the local half: the service, the `flow` CLI, the desktop and browser clients,
and the shared brain runtime. It holds only the _client_ side of Flow Cloud —
[`cloud-client.ts`](../../apps/server/src/brain/cloud-client.ts) posting to `/v1/brain` and
`/auth/connect` against the contracts in `flow-t3/cloud`. A `/v1/brain` host role, accounts,
invitations and the Slack agent are never implemented here; work that seems to need them belongs
on the other side of that client contract.

One behavioral consequence of the same boundary: a workspace bound to a remote brain routes
graph and embedding operations to that brain, and when it is unreachable the operation fails. It
never falls back to a local brain — silently answering from different data is worse than an
error.

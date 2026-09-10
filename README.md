# Flow

This branch establishes Flow's agent workspace on the T3 Code foundation. It is
an independent fork, with T3's original Git history retained. The web and desktop
interface includes a local Brain backed by native FalkorDB. Open **Brain** in the
sidebar, use the selector and **New brain** inside that page, and choose Claude Code,
Codex, or OpenCode as its default indexing CLI. Connect GitHub repositories or a
local Git folder through the source cards. Public repositories
work without GitHub sign-in; private repositories use the selected computer's
existing GitHub CLI sign-in (managed in Settings → Source control).

Indexing uses Flow's original graph-builder instructions and graph gateway,
including provenance, duplicate detection, usage contracts, cross-repository
links, and incremental Git updates. Builders write directly to FalkorDB as they
explore; the graph and per-repository activity logs refresh every two seconds
while the page is visible. The selected CLI uses its existing credentials and
Flow's indexing model defaults (overridable with GRAPH_BUILDER_MODEL).
Session capture feeds Flow's original checkpoint and memory pipeline.
Linear/Fireflies/notes/Slack workers and cloud Brain migration remain deferred. Older prototype graphs are retained for reference;
reindex their sources to build them with the full Flow pipeline.

When adding a project in the web or desktop UI, choose its brain (or create one).
The repository is registered as a source automatically. Change the connection
in **Brain → Projects**; disconnecting a project retains the old brain's source.
Agent sessions receive Flow's original instructions and full `orient` result,
then use the original graph, memory and source tools for retrieval. Session
restart, compaction and Brain changes refresh orientation; no per-turn memory
injection is added. Mobile project creation does not yet have a Brain picker.

The root contains T3's web, desktop, mobile, and server applications. The existing
Flow implementation is preserved under [`flow/`](flow/README.md) as a migration
reference. The active shared Brain packages live under
[`flow-t3/shared/`](flow-t3/README.md); public cloud interfaces live under
`flow-t3/cloud/`. T3 builds from the shared packages without requiring the Flow CLI.

The first integration target is the complete free local developer setup. A
workspace has one brain, initially running locally; a future cloud migration
will transfer its data and change its endpoint. Agent execution location is
independent of brain location.

The intended local experience is to launch the app and create projects in the UI,
without running `flow up`. Local workspaces in one app server share an app-managed FalkorDB instance with
separate workspace graphs and one lazily loaded embedding model. No Docker or
`flow up` is used. Native FalkorDB binaries support Apple Silicon macOS 15+ and Linux
x64; other platforms are not supported by this native integration yet. On macOS,
the app downloads a checksum-verified upstream binary bundle with its native
libraries (no Homebrew or Python interpreter required). The graph
storage directory is derived from the installation home under `~/.flow-brain/`
(to keep Unix socket paths short); workspace settings and model files are kept
in that installation’s `userdata/brain/`. The UI uses the selected computer’s
authenticated connection. Moving a brain independently to a remote backend is
still a future integration.

This branch does not migrate installed data, configure Flow Cloud, or change
existing installations. Use the Flow installation instructions below to run
this fork. See [NOTICE.md](NOTICE.md) for attribution and license boundaries.

## Upstream T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

Install Flow on an Apple Silicon Mac running macOS 15 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/samyakkkk/flow/release/install.sh | bash
open "$HOME/Applications/Flow.app"
```

The installer downloads a ready-built app with its own Node runtime, server,
web interface, and native Brain libraries. No Node, npm, Homebrew, Docker, or
local build is required. Open **Flow** from your Applications folder whenever
you want to use it; its interface opens in your browser. You can drag its icon
to the Dock. Configure your provider and Brain in the app.

The `flow` terminal command is also installed in `~/.local/bin`. See the
[source-checkout instructions](./docs/user/install.md#install-from-a-checkout)
for development and Linux installations.

The installer follows published browser releases. Pushes to the `release` branch
build and publish the next version after release checks pass.

### Updates

Flow checks for updates in the background at startup and every six hours while
running. Updates are downloaded and verified in a separate directory. When one is ready, the sidebar
shows **Update ready · Restart to update**. Confirm the restart to apply it; the
page reloads when Flow reconnects. Running sessions are not restarted without
your action. A prepared update also takes effect when you next start the stopped
app. Use `flow update` to prepare an update immediately, or `flow update --check`
to check without downloading it.

See [installation and provider setup](./docs/user/install.md) and
[updating Flow](./docs/user/updating.md) for details. The upstream `npx t3`
package and T3 desktop downloads install upstream T3 Code.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

Publishing Flow? Use the repository's [$deploy-flow skill](./.agents/skills/deploy-flow/SKILL.md)
and [browser release guide](./docs/operations/release.md#flow-browser-releases).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

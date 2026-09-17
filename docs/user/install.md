# Install Flow

Flow runs coding agents and a local Brain on your computer. You can install it as
a desktop app or with the bash installer described here; both share one local Flow
service and one Brain, and you can have both. This page covers the bash installer
and installing from a checkout. Desktop downloads are in the
[README](../../README.md#install).

## Requirements

- An Apple Silicon Mac running macOS 15 or newer, or Ubuntu 24.04-compatible Linux x64, with an internet connection.
- A supported provider account; configure its CLI and login in Flow's provider settings.

Flow includes its own Node runtime and ready-built dependencies. You do not need
Node, npm, Homebrew, Docker, Git, or a compiler to install it.

## Install with bash

```bash
curl -fsSL https://raw.githubusercontent.com/samyakkkk/flow/release/install.sh | bash
```

The installer verifies the release archive's SHA-256 checksum and installs the
ready-built server, web app, native libraries, and private Node runtime. Your
system Node installation is not changed. The Brain downloads its embedding model
automatically on first use.

When you run it in a terminal, the installer starts Flow and opens it in your
browser. Afterwards `flow` starts or reuses that service and opens it again;
`flow --no-open` prints the link instead, for a machine without a browser.
Installing does not add a desktop app — the signed [desktop app](https://github.com/samyakkkk/flow/releases)
is a separate download, and both use the same local service and Brain.

The optional terminal command is installed in `~/.local/bin`. Add that directory
to PATH to use `flow` from any terminal. To choose another CLI prefix, append
`-s -- --prefix /your/prefix` to the `bash` command above. Unrelated launchers and
applications are never overwritten.

The installer also retires recognized legacy Flow aliases, CLI wrappers, coding-agent
hooks, and background services, even if the old CLI or Node installation is broken.
It stops only identifiable Flow services and containers; unrelated Redis instances
are left running. Changed files and container restart settings are backed up under
`~/.flow/retired/`. Old Brain data is kept in place and is not migrated.
Restart any existing terminals and coding-agent sessions to clear their cached
aliases and hooks. Any legacy items that cannot be safely identified are
reported for review.

If you installed an earlier source-built release, rerun this installer to adopt
the bundled runtime. Existing data stays in place; an active server keeps running
until you explicitly restart it. Future bundled updates require no local build.

Release files live in `~/.local/share/flow-browser/releases`. Application data
lives separately under `~/.local/share/flow-browser/instance-home`. Existing
source-checkout, legacy Flow, and T3 application data are not migrated. Set
`FLOW_RELEASE_HOME` during installation to choose another installation directory;
the installed launcher remembers it. `FLOW_INSTANCE_HOME` overrides the instance
registry when launching, but do not point it at a running source installation.

`flow` starts the local server in the background and opens a pairing link in
your browser. Closing the browser or terminal leaves the server running.
Create projects in the app and choose their Brain. See
[updating Flow](./updating.md) for automatic release preparation and
[local instances](./local-instances.md) for stop, restart, and development commands.

## Install from a checkout

For development, or Linux x64 where the ready-built installer is not yet available,
install Node.js 24.13.1+ within 24.x and Git, then run:

Linux Brain support requires Ubuntu 24.04 or compatible system libraries
(glibc 2.38 and GLIBCXX_3.4.32 or newer). Debian 12 is not supported by the
bundled native database.

```bash
git clone --branch main-v2 --single-branch https://github.com/samyakkkk/flow.git
cd flow
bash scripts/install-flow.sh
export PATH="$HOME/.local/bin:$PATH"
flow
```

Keep this checkout in place: its installed launcher uses it directly. This
installation uses the existing `~/.local/share/flow-app` instance registry and
requires manual source updates. It does not participate in release auto-updates.
Use a different `--prefix` if you want to retain both launchers.

## Desktop

Prefer a native window? Download the Flow desktop app for macOS (Apple Silicon or
Intel) or Linux x64 from the links in the [README](../../README.md#install). It is
signed, notarized, and updates itself.

The desktop app connects to the same local Flow service as the `flow` command, so
installing both is fine: quitting the app leaves the service, its Brain, and your
connected coding agents running. Manage the service from
**Settings → Connections → Flow service** in the app, or with `flow service` in a
terminal.

T3 Code's npm package and desktop package-manager installs are upstream T3 releases
and do not install Flow.

## Coding agents

Flow's Brain is available to the coding agents you already use: Claude Code,
Codex, Cursor, Gemini CLI, OpenCode, GitHub Copilot, and Antigravity. When Flow
starts on a computer, it registers one hook, one `flow-graph` MCP server, and one
`flow` skill in each detected agent's own user configuration. Nothing is written
into your repositories. Restart the agents once and approve their hook or MCP
trust prompt if they show one; that approval covers every folder. The last step of
onboarding lists the tools it found and connects any that are not connected yet.

A folder is connected when its repository belongs to a Brain: any checkout of a
repository you connected to a Brain, or any project whose Brain you chose in
Flow, gets the Brain's tools and conversation capture automatically. Running an
agent in a parent folder that holds several checkouts works when they all belong
to the same Brain. Folders that belong to no Brain, or whose checkouts belong to
different Brains, get no Flow tools and nothing is captured. Bind such a folder
to a Brain from its project in Flow, or with `flow setup --brain <id> --folder
<path>` in a terminal.

`flow agents resolve --folder <path>` shows what a folder resolves to,
`flow agents doctor --folder <path>` checks a connected folder end to end, and
`flow agents uninstall` removes the registrations from this computer.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from Flow's provider settings.                               |

For Codex and Claude, onboarding also offers **Install** and **Sign in** in its
setup terminal. These use the providers' standalone installers; no system Node
is needed.

Provider CLIs must be on the server's `PATH`. If Flow cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Flow can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Flow does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Remove Flow

```bash
flow uninstall            # remove Flow, keep your projects, conversations and Brains
flow uninstall --purge    # remove Flow and delete that data as well
```

Both unregister Flow from your coding agents, stop and remove the background
service, and delete the installation and the `flow` command. A `flow` command
belonging to another installation is left alone, and so is the desktop app,
which you remove like any other application.

`--purge` also deletes every data home this installation owns and its Brain
storage in `~/.flow-brain`. Nothing restores that. Backups Flow took of files it
changed elsewhere (`~/.flow/retired/`) survive a purge, because they are the
only copy.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Local instances](./local-instances.md): manage the background server.
- [Updating Flow](./updating.md): update your installation.

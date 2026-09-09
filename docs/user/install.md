# Install Flow

Flow runs coding agents and a local Brain on your computer. The bash installer
sets up the local browser app from stable GitHub Releases.

## Requirements

- An Apple Silicon Mac running macOS 15 or newer, with an internet connection.
- A supported provider account; configure its CLI and login in Flow's provider settings.

Flow includes its own Node runtime and ready-built dependencies. You do not need
Node, npm, Homebrew, Docker, Git, or a compiler to install the browser app.

## Install with bash

```bash
curl -fsSL https://raw.githubusercontent.com/samyakkkk/flow/release/install.sh | bash
open "$HOME/Applications/Flow.app"
```

The installer verifies the release archive's SHA-256 checksum and installs the
ready-built server, web app, native libraries, and private Node runtime. Your
system Node installation is not changed. The Brain downloads its embedding model
automatically on first use.

**Flow.app** is added to your personal `~/Applications` folder. Opening it starts
Flow and opens your browser; reopening it returns to the existing instance. Drag
it to the Dock if you want a shortcut. This is a browser launcher, not Electron.

The optional terminal command is installed in `~/.local/bin`. Add that directory
to PATH to use `flow` from any terminal. To choose another CLI prefix, append
`-s -- --prefix /your/prefix` to the `bash` command above. Unrelated launchers and
applications are never overwritten.

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

These scripts install the local browser app. T3 Code's npm package and desktop
package-manager installs are upstream T3 releases and do not install Flow.

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

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Local instances](./local-instances.md): manage the background server.
- [Updating Flow](./updating.md): update your installation.

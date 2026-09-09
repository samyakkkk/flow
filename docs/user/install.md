# Install Flow

Flow runs coding agents and a local Brain on your computer. The bash installer
sets up the local browser app from stable GitHub Releases.

## Requirements

- Node.js 24.13.1 or later in the 24.x line, with npm on PATH.
- curl and tar for downloading and extracting the release.
- Apple Silicon macOS 15+ or Linux x64 for the native local Brain.
- An installed, authenticated provider to start a thread; configure it after launch if needed.

## Install with bash

```bash
curl -fsSL https://raw.githubusercontent.com/samyakkkk/flow/release/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
flow
```

The installer on the `release` branch downloads the latest published stable
Flow browser release. Existing installations follow the same release feed.

The installer verifies the release archive's SHA-256 checksum, installs the
release's locked dependencies, and builds the web app. Node.js must already be
installed; native dependencies may require your platform's build tools if a
prebuilt binary is unavailable. Installation can take a few minutes.

The launcher is installed in `~/.local/bin`. Add that directory to your shell's
PATH for future terminals. To choose another prefix, append `-s -- --prefix
/your/prefix` to the `bash` command above. The installer refuses to overwrite an
unrelated command; `command -v flow` shows which command your shell finds.

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

For development or before the first GitHub release, use Git and run:

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

# Flow CLI: local and Cloud Brains

Open your Brain's Cloud dashboard, choose **Copy setup prompt**, and give the
prompt to a coding agent on the machine where you work. Choose the project
folders to connect. The prompt installs Flow's CLI and configures supported
tools detected on that machine. Restart those tools and approve their integration
prompts. The setup prompt expires after ten minutes; copy another if needed.

This installation supports Apple Silicon macOS 15+ and Ubuntu 24.04-compatible
Linux x64. No desktop app is required. An installed, signed-in coding provider is
needed for local conversation processing. Knowledge is stored in your Cloud
Brain; conversation capture and curation run on your machine.

The CLI lives at `~/.local/share/flow-cloud-cli/bin/flow`. It also installs
`~/.local/bin/flow` when that path is free. If another Flow installation owns the
command, use the CLI's full path. Existing Mac apps and their data are kept.

Flow checks its own release channel whenever invoked and downloads updates in
the background. Later invocations use the downloaded CLI. Network or verification
failures leave the installed version usable. Running servers keep their current
version until restarted; use `flow restart` when you are ready to apply a server
update. `flow update` waits for an update to finish downloading.

Use `flow agents doctor --folder /path/to/project` to check a connection, or
`flow agents remove --folder /path/to/project` to disconnect that folder's tools.
A successful connection check does not prove that a conversation has been
captured: run a fresh agent conversation and check its saved notes.

## Use Flow locally

Run `flow` to start or reuse the local service and open its browser UI. Choose a
local Brain and connect your project folders. `flow --web` also opens the browser;
`flow --no-open` prints a pairing link for a machine without a browser.
The package includes its own Node runtime; you do not need to install Node or npm.
Desktop applications continue to use their existing installation for now.

For setup from a terminal or coding agent, create a local Brain and use the returned ID:

```sh
flow brains create --name "My projects" --cli claude
flow brains list
flow setup --brain <id> --folder /path/to/project
```

Choose `claude`, `codex` or `opencode` for the installed provider that processes
Brain conversations. Setup configures detected supported tools by default; use
`--harness claude,codex` to choose explicitly. Restart the tools and approve their
integration prompts. Local and Cloud projects can coexist on the same service.
`flow setup` without a Brain selection opens the UI.

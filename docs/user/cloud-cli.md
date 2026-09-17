# Flow CLI: local and Cloud Brains

Open your Brain's Cloud dashboard, choose **Copy setup prompt**, and give the
prompt to a coding agent on the machine where you work. The prompt installs
Flow's CLI and registers Flow once in each supported coding tool detected on
that machine; checkouts of the Brain's repositories connect automatically, and
you can bind other folders explicitly. Restart those tools and approve their
integration prompts once. The setup prompt expires after ten minutes; copy
another if needed.

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

Use `flow agents resolve --folder /path/to/project` to see which Brain a folder
uses, `flow agents doctor --folder /path/to/project` to check a connection, or
`flow agents remove --folder /path/to/project` to unbind that folder.
A successful connection check does not prove that a conversation has been
captured: run a fresh agent conversation and check its saved notes.

## Use Flow locally

Run `flow` to start or reuse the local service and open its browser UI. Choose a
local Brain and connect your project folders. `flow --web` also opens the browser;
`flow --no-open` prints a pairing link for a machine without a browser.
The package includes its own Node runtime; you do not need to install Node or npm.
Desktop applications continue to use their existing installation for now.

For setup from a terminal or coding agent, install the tools once, then create a
local Brain and bind any folder that is not a checkout of one of its repositories:

```sh
flow setup
flow brains create --name "My projects" --cli claude
flow brains list
flow setup --brain <id> --folder /path/to/folder
```

Choose `claude`, `codex` or `opencode` for the installed provider that processes
Brain conversations. `flow setup` registers Flow in the supported tools detected
on this computer; use `--harness claude,codex` to choose explicitly, or
`--harness all` to pre-wire tools you install later. Restart the tools and
approve their integration prompts once. Local and Cloud projects can coexist on
the same service.

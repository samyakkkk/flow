# Connect coding tools to a Cloud Brain

Open your Brain's Cloud dashboard, choose **Copy setup prompt**, and give the
prompt to a coding agent on the machine where you work. Choose the project
folders to connect. The prompt installs Flow's Cloud CLI and configures supported
tools detected on that machine. Restart those tools and approve their integration
prompts. The setup prompt expires after ten minutes; copy another if needed.

This installation supports Apple Silicon macOS 15+ and Ubuntu 24.04-compatible
Linux x64. No desktop app is required. An installed, signed-in coding provider is
needed for local conversation processing. Knowledge is stored in your Cloud
Brain; conversation capture and curation run on your machine.

The CLI lives at `~/.local/share/flow-cloud-cli/bin/flow`. It also installs
`~/.local/bin/flow` when that path is free. If another Flow installation owns the
command, use the Cloud CLI's full path. Existing Mac apps and their data are kept.

Flow checks its own release channel whenever invoked and downloads updates in
the background. Later invocations use the downloaded CLI. Network or verification
failures leave the installed version usable. Running servers keep their current
version until restarted; use `flow restart` when you are ready to apply a server
update. `flow update` waits for an update to finish downloading.

Use `flow agents doctor --folder /path/to/project` to check a connection, or
`flow agents remove --folder /path/to/project` to disconnect that folder's tools.
A successful connection check does not prove that a conversation has been
captured: run a fresh agent conversation and check its saved notes.

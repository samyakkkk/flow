# Updating Flow

## GitHub release installation

Flow checks for a stable GitHub release at startup and every six hours while
running. It downloads and verifies the archive and builds it in a new directory.

When the update is prepared, **Update ready** appears in the browser app's
sidebar. Select **Restart to update**, then confirm when you are ready to
interrupt active work. Flow restarts on the same address and the page reloads
once the updated server is ready. Choose **Later** to keep working; the notice
stays available. This restarts the server hosting the browser app, not a
different remote environment selected in a thread.

A prepared update also takes effect the next time you start the stopped primary
app. Your instance identity, projects, threads, and Brain storage stay in the
same data directory. Terminal commands remain available:

```bash
flow update --check  # Check availability without preparing the update
flow update          # Download and build the latest stable release now
flow restart         # Apply the prepared release; interrupts active work
```

Set `FLOW_AUTO_UPDATE=0` in your shell configuration to disable automatic
preparation. Manual `flow update` remains available. Development instances stay
on their saved checkout and do not switch versions automatically.

If downloading, checksum verification, or building fails, the previous release
remains selected. Inspect `~/.local/share/flow-browser/update.log` for automatic
update failures, then retry with `flow update`. Paths are relative to
`FLOW_RELEASE_HOME` when using a custom installation directory. Previous release
directories are retained. Preparation checks the server's version command and
web build; it does not provide database rollback if a new server fails after
startup or applies a migration.

## Source-checkout installation

The checkout launcher installed by `scripts/install-flow.sh` does not use GitHub
release updates. From your Flow checkout on `main-v2`, finish active work, then
run each command only after the previous one succeeds:

```bash
flow stop
git pull --ff-only origin main-v2
bash scripts/install-flow.sh
flow
```

If Git reports local changes or diverged history, resolve those before
continuing. Stop any development instances using this checkout too, so files
are not changed beneath their running servers. Updating preserves application data.

## Desktop updater

Packaged desktop builds inherit T3's background checks and user-triggered
download/install through Electron. That is separate from the browser release
installer. See the maintainer [release guidance](../operations/release.md) for
Flow desktop distribution requirements.

## Upstream T3 Code installations

The guidance below applies to upstream T3 releases. Do not use `npx t3` to
update a Flow installation; it installs the upstream application.

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is off by default.
Enable it to resume supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
T3 Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
If you previously enabled continuation for updates, enable this setting once
to allow recovery without a connected client.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Stop the command-line server on its host and relaunch with the copied command, keeping your usual startup options.                                                                              |

For a background service, run the matching version's CLI on the host:

```sh
npx t3@<client-version> service update
```

Replace `<client-version>` with the version shown in the notice. Using
`@latest` only resolves the mismatch if your client is on that release. An older
service launcher may require this local update before it supports remote updates
and rollback.

For a foreground server, the copied command is `npx t3@<client-version>`. Add
`serve` if you normally run without a browser, and preserve options such as
`--host` or `--tailscale-serve`. See
[background services](./background-service.md) for service management.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

## Mobile updates

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.

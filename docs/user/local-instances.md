# Run Flow in a browser

The launcher starts chat and brain together in the background.
For the GitHub release installer, start with [Install Flow](./install.md).
The commands below work for release and source installs; development instances
still require a source checkout.

To install directly from a checkout:
It requires Node.js 24.13.1+ (24.x) and the checkout's dependencies. To install
its command and build the web app, run:

```sh
bash scripts/install-flow.sh
```

Add the printed installation directory to PATH if needed. Then:

```sh
flow
flow status
flow stop
flow restart
```

`flow` opens the existing app or starts it. On a Mac with the Flow desktop app
installed it opens that app; otherwise it opens a pairing link in your browser
(`flow --browser` forces the browser). You do not need to remember its port.
Closing the terminal, browser, or app leaves it running. Opening the desktop app
while the service is stopped starts it.
`--no-open` prints the pairing link instead. Restart can interrupt active turns;
it preserves application data. Provider CLI sign-ins remain shared.

The checkout installer runs from and retains a reference to its checkout; keep that
checkout available. It does not yet download versioned releases or implement
`flow update`/`flow repair`. Reinstalling refreshes the launcher without
restarting apps. It refuses to overwrite an unrelated command. The existing
`~/.flow/bin/flow` memory helper is left intact; integrations using its absolute
path continue to work.

## Keep Flow running in the background

```sh
flow service install
flow service status
flow service uninstall
```

Installing the service starts Flow at login on macOS, and with your user session
on Linux. `flow status`, `flow stop` and `flow restart` keep working as before:
a service you stop with `flow stop` stays stopped until you start it again, and
starting and restarting go through the service manager. `flow service status`
prints where the service is installed and what it is doing. Uninstalling removes
it from startup and leaves your projects, threads, brain and settings untouched.

The Flow desktop app connects to this same service, so quitting the app leaves
your background work, indexing and captured agent sessions running. To stop or
restart the service from the app, use **Settings → Connections → Flow service**.

## Development

```sh
flow dev test1 --isolated
flow dev test2 --shared-brain --from primary
flow dev ui1 --ui-only --from primary
flow dev test1
flow dev test1 --replace
flow dev test3 --fresh
flow dev list
flow dev status test1
flow dev stop test1
```

A new named instance defaults to isolated mode and records the current checkout.
Use `--code /absolute/path/to/checkout` when creating it elsewhere. Later commands
reuse that checkout, mode and data regardless of the current directory. To
change the checkout or mode, create a new name. `--replace` restarts with saved
settings; `--fresh` only accepts a new name and creates empty isolated storage.

- **Isolated:** separate chat history, projects, brain, indexing and memory.
- **Shared brain:** separate chats and project bindings, using the chosen
  instance's live brain through authenticated local requests. Select/connect a
  brain to the dev project in settings. Brain writes and captured memories
  modify that shared brain. Start the source instance first.
- **UI only:** another development frontend against the source's existing chat
  server and brain. UI actions affect the source's real data. Its proxy follows
  source restarts; stopping this frontend never stops the source.

All modes share provider sign-ins. Separate application data does not isolate
edits to the same working folder; use separate Git worktrees for independent
coding tests. Test instances do not copy primary projects or connector settings.

Data and saved instance configuration for source installations live beneath
`~/.local/share/flow-app/instances`. Release installations use
`~/.local/share/flow-browser/instance-home/instances` by default. For automation,
`FLOW_INSTANCE_HOME` selects an entirely separate registry. It does not change
provider credential homes.

Your application data itself lives in a separate home. If you already have a T3
Code or Flow install at `~/.t3`, it is adopted where it is and keeps using that
folder; a fresh install uses `~/.flow`. Either way the data is never moved or
copied to a new location, so the brain, indexing and any managed worktrees stay
intact. `--home` lets you point a new installation at an existing folder, but an
installation that already records a home will not accept a different one.

The current supervisor and installation script target macOS/Linux. Windows
process-tree supervision remains a follow-up.

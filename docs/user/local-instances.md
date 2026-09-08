# Run Flow in a browser

The source-checkout launcher starts chat and brain together in the background.
It requires Node.js 22.16+ or 24.10+ and the checkout's dependencies. To install
its command and build the web app, run:

```sh
./scripts/install-flow.sh
```

Add the printed installation directory to PATH if needed. Then:

```sh
flow
flow status
flow stop
flow restart
```

`flow` opens the existing app or starts it and opens a pairing link. You do not
need to remember its port. Closing the terminal or browser leaves it running.
`--no-open` prints the pairing link instead. Restart can interrupt active turns;
it preserves application data. Provider CLI sign-ins remain shared.

This installer runs from and retains a reference to its checkout; keep that
checkout available. It does not yet download versioned releases or implement
`flow update`/`flow repair`. Reinstalling refreshes the launcher without
restarting apps. It refuses to overwrite an unrelated command. The existing
`~/.flow/bin/flow` memory helper is left intact; integrations using its absolute
path continue to work.

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

Data and saved instance configuration live beneath
`~/.local/share/flow-app/instances`. For automation, `FLOW_INSTANCE_HOME` selects
an entirely separate registry. It does not change provider credential homes.
The first primary launch starts with new storage; existing legacy T3/Flow data
is not migrated automatically.

The current supervisor and installation script target macOS/Linux. Windows
process-tree supervision and standalone release distribution remain follow-ups.

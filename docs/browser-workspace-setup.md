# Connect employee tools to a team deployment

In the production dashboard, choose **Connect a workspace** and copy the command.
Run it from the Git repository on your own computer:

```sh
flow setup https://flow.company.com/engineering
```

The CLI requires an interactive terminal, lists detected tools, lets you change
that selection, and asks before installing knowledge access and capture hooks.
It opens a browser approval page. Sign in, verify that the displayed code matches
your terminal, and approve only a setup you initiated. The CLI verifies both
project endpoints before writing integrations, then exits. No background helper,
inbound port, command listener, or remote execution enrollment is installed.

The dashboard lists your configured workspace, device label and selected tools.
This is saved configuration metadata, not proof that your computer is online.
Capture and extraction are explicitly unverified in this card; inspect real
sessions and memories for those signals. No local absolute path is sent during
pairing, and the dashboard cannot browse the connected laptop.

A later `flow setup engineering` can reuse the personal remote binding. Use
`flow setup --remove` in the repository to remove its local integrations. Revoke
the named personal token in the dashboard's Access management to stop its cloud
access. Revocation does not remotely remove files from your computer. Existing
local dashboards retain their folder-picker setup path.

## Security boundaries

- A ten-minute signed ticket binds the project, workspace label, device label
  and hash of a random CLI-only redemption secret. The browser never receives
  that secret. Pending requests do not create server-side records.
- Browser approval requires a signed-in user with a current project grant and
  a same-origin request. Approval never happens automatically on page load.
- Redemption checks the secret, expiry, live user and grant, and consumes the
  approval once. Same-user browser approval retries are idempotent.
- Minted credentials are personal and restricted to one project, including for
  owners. Existing gateway/orchestrator PAT rules permit knowledge and capture,
  not agent execution or administration. Grant/token revocation is rechecked by
  the services (auth-store cache is at most two seconds).
- The dashboard relays a fixed knowledge/capture endpoint allowlist using the
  caller's PAT. It never injects an administrator credential into that relay.
  Only the dashboard HTTPS port is required; gateway ports can stay private.
- Session capture shares transcript data with the team project. It is a separate
  consent from workspace trust or command permissions in the coding agent.
  Flow does not change those agent permissions or bypass their approvals.

This uses the deployment's existing single-dashboard JSON auth store. It is not
an implementation of distributed authorization across multiple dashboard writers.
Device names are labels, not hardware attestation. The flow prevents dashboard
credentials from becoming a laptop control channel; it does not protect against
an already compromised laptop or unsafe actions independently approved in an agent.

## Validation

```sh
node --import tsx --test dashboard/test/device-pairing.test.ts \
  orchestrator/test/browser-setup.test.mjs \
  orchestrator/test/connector-auth.test.ts \
  orchestrator/test/remote-setup.test.mjs
npm --prefix dashboard run build
```

For an isolated deployment, the opt-in live check creates a temporary member,
exercises browser-approval HTTP boundaries and revocation, then deletes it:

```sh
python3 scripts/check-browser-setup.py https://flow-test.example engineering /private/owner-login.json
```

On 2026-09-06, the separate `flow-pairing-test` alias connected a disposable Mac
repository to the Hetzner harness-cloud deployment. Terminal confirmation,
browser code approval, endpoint verification, Codex materialization and workspace
listing passed. A real Codex session `01a0754e-7316-7af0-90b6-4f0f48c54aec` read
the skill and called native MCP orient, returning harness-cloud/pairing-fixture.
The dashboard displayed its captured session. This invocation used Codex's
explicit hook-trust bypass for the test; setup itself does not grant hook trust.
Twenty-four live HTTP checks passed, including temporary member cleanup. Memory
extraction was not retested by this setup-only session.

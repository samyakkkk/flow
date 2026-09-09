---
name: deploy-flow
description: Prepare, publish, and verify a Flow local browser app release from the release branch using GitHub Actions. Use when asked to deploy Flow, ship a browser version, publish installer assets, or verify release and auto-update delivery. Clarify the target when desktop or cloud deployment is intended; those use different procedures.
---

# Deploy Flow

Ship the local browser app launched with `flow`. Read the repository's `AGENTS.md`
and orient through Flow's graph when available. Verify memory against the checkout.

## Establish the target

Read the authoritative [browser workflow](../../../.github/workflows/flow-browser-release.yml),
[release guide](../../../docs/operations/release.md), [installer](../../../install.sh),
and [release manager](../../../scripts/flow-release.mjs). Consult the user guides
for [installation](../../../docs/user/install.md) and [updates](../../../docs/user/updating.md).

Use repository `samyakkkk/flow`, publication branch `release`, and stable tags `flow-vX.Y.Z`.
Do not use the inherited `v*` desktop/npm workflow for browser distribution.
This release ships source that recipients build locally, not a hosted service.

Inspect git status, remotes, GitHub authentication, remote tags, and existing
releases. Fetch `origin/release` and `origin/main-v2` without resetting or switching the user's checkout.
Choose a full verified commit that descends from `origin/release`. Development
can stay on `main-v2`; a push to `release` automatically allocates the next patch
above existing stable browser tags. Verify the candidate contains the workflow,
installer, release manager, and intended changes. The public sharing command uses
`release/install.sh` and requires published browser assets.

## Prepare and check

Use an isolated checkout of the selected commit for fixes and installation tests.
The checkout hosting this agent may run under Node's file watcher: source edits
can restart Flow and interrupt the session. Never stop or restart the user's
running Flow to test deployment. Use disposable installation and state directories;
never use the live database or overwrite the user's launcher.

Match the workflow's Node requirement (currently 24.13.1 or newer within 24.x).
Run its focused release tests:

```bash
node --test scripts/flow-release-version.test.mjs scripts/flow-release.test.mjs scripts/instances/launcher.test.mjs scripts/instances/release-control.test.mjs scripts/instances/release-handoff.test.mjs
```

For source-install verification, follow the workflow's staged archive procedure:
exclude `.repos`, stamp versions in staged files only, and install using a temporary
`--prefix`. Run its focused server/web update tests and server `--version` check.
Do not run repository-wide checks. CI verifies installation on Linux; that does
not prove macOS compatibility or the running-app update experience.

Resolve failures before publication. Search unexpected symptoms in Flow's graph
before investigating code. Keep fixes separate from the watched live checkout.

## Publish

Pushing to `release` publishes a real stable release and changes the update feed.
A preparation-only request does not authorize publication. When publication is
already authorized, proceed without asking again; otherwise present the verified
SHA, changes, and checks before requesting missing publication approval.

Push the verified full `FLOW_COMMIT` using a normal fast-forward branch update:

```bash
git merge-base --is-ancestor origin/release "$FLOW_COMMIT"
git push origin "$FLOW_COMMIT:refs/heads/release"
```

Do not force-push or manually create a tag to trigger publication. The workflow
pins the event SHA and allocates the next patch version. If manual dispatch is
available, select `release`; an optional version supports a greater minor/major.
Do not change the default branch merely to enable dispatch.

Find the run matching the pushed SHA and wait for packaging and publication.
Inspect logs and partial publication on failure. A full rerun after success
allocates another patch; prefer rerunning failed jobs for recovery. Never delete
tags or releases automatically. If GitHub reports an account billing lock,
report that automatic publication is blocked rather than claiming delivery.

## Verify delivery

Confirm the release is stable, not a draft or prerelease, and GitHub's
`/repos/samyakkkk/flow/releases/latest` points to the intended tag. Verify the remote
tag resolves to the selected commit. Require these three assets:

- `flow-source.tar.gz`
- `flow-source.tar.gz.sha256`
- `flow-release.mjs`

Download assets to a temporary directory. Check the archive with
`sha256sum -c flow-source.tar.gz.sha256`, or on macOS,
`shasum -a 256 -c flow-source.tar.gz.sha256`. Check the bootstrap matches the release
source. Keep the repository's latest stable release on the Flow browser channel;
a different channel can break installer discovery.

Smoke-test the published bootstrap with a temporary `FLOW_RELEASE_HOME` and
launcher `--prefix`. Keep instance state isolated too. Verify the installed launcher
and server version without touching live Flow. Before broad sharing, verify
supported target platforms and an upgrade from the preceding version. For requested
browser verification, follow [test-t3-app](../test-t3-app/SKILL.md) and the repository's
browser permission rules. Never claim tests that were not performed.

Updates prepare automatically at startup and periodically. The running browser
shows **Update ready** and asks before **Restart to update**; that restart can
interrupt sessions and terminals. `flow update --check` checks, `flow update`
prepares, and `flow restart` explicitly restarts. Download/build failure preserves
the selected version; this does not promise database rollback after a new runtime
starts.

Report the version, full SHA, workflow and release links, verification results,
and remaining platform checks. Include the installation command from the user
guide once public delivery is verified. Distinguish prepared from published.

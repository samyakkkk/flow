---
name: deploy-flow
description: Prepare, publish, and verify a Flow local browser app release from main-v2 using GitHub Actions. Use when asked to deploy Flow, ship a browser version, publish installer assets, or verify release and auto-update delivery. Clarify the target when desktop or cloud deployment is intended; those use different procedures.
---

# Deploy Flow

Ship the local browser app launched with `flow`. Read the repository's `AGENTS.md`
and orient through Flow's graph when available. Verify memory against the checkout.

## Establish the target

Read the authoritative [browser workflow](../../../.github/workflows/flow-browser-release.yml),
[release guide](../../../docs/operations/release.md), [installer](../../../install.sh),
and [release manager](../../../scripts/flow-release.mjs). Consult the user guides
for [installation](../../../docs/user/install.md) and [updates](../../../docs/user/updating.md).

Use repository `samyakkkk/flow`, branch `main-v2`, and stable tags `flow-vX.Y.Z`.
Do not use the inherited `v*` desktop/npm workflow for browser distribution.
This release ships source that recipients build locally, not a hosted service.

Inspect git status, remotes, GitHub authentication, remote tags, and existing
releases. Fetch `origin/main-v2` without resetting or switching the user's checkout.
Choose a full, pushed commit SHA on that branch and a new stable version greater
than the current browser release. Distinguish an absent first release from an
authentication or network failure. Ensure the tag is absent locally and remotely
and no release already uses it.

Verify the target commit contains the workflow, installer, release manager, and
intended changes. Tagging HEAD cannot release uncommitted changes. For the first
release, ensure the public `main-v2/install.sh` URL will also exist. The sharing
command needs both that script and published assets.

## Prepare and check

Use an isolated checkout of the selected commit for fixes and installation tests.
The checkout hosting this agent may run under Node's file watcher: source edits
can restart Flow and interrupt the session. Never stop or restart the user's
running Flow to test deployment. Use disposable installation and state directories;
never use the live database or overwrite the user's launcher.

Match the workflow's Node requirement (currently 24.13.1 or newer within 24.x).
Run its focused release tests:

```bash
node --test scripts/flow-release.test.mjs scripts/instances/launcher.test.mjs scripts/instances/release-control.test.mjs scripts/instances/release-handoff.test.mjs
```

For source-install verification, follow the workflow's staged archive procedure:
exclude `.repos`, stamp versions in staged files only, and install using a temporary
`--prefix`. Run its focused server/web update tests and server `--version` check.
Do not run repository-wide checks. CI verifies installation on Linux; that does
not prove macOS compatibility or the running-app update experience.

Resolve failures before publication. Search unexpected symptoms in Flow's graph
before investigating code. Keep fixes separate from the watched live checkout.

## Publish

Pushing a matching tag or dispatching this workflow publishes a real stable
release and changes the update feed. Neither is a dry run. A request to write this
skill or prepare a release does not authorize publication. If publication is
already authorized, proceed without asking again. Otherwise, finish preparation
and present the concrete version, SHA, changes, and checks before requesting the
missing publication approval.

Prefer an exact-commit tag. Set `FLOW_VERSION` and `FLOW_COMMIT` to the verified
stable version and full SHA. Run each step only after the preceding one succeeds:

```bash
FLOW_TAG="flow-v${FLOW_VERSION}"
git merge-base --is-ancestor "$FLOW_COMMIT" origin/main-v2
git tag "$FLOW_TAG" "$FLOW_COMMIT"
git push origin "refs/tags/$FLOW_TAG"
```

Never force a tag, push all tags, or overwrite an existing release to resolve a
collision. Alternatively, when manual dispatch is available, run **Flow browser
release** with the stable version input. This selects `main-v2` HEAD when the job
checks out source, not a previously reviewed SHA. Verify the actual packaged
commit. Do not change the default branch merely to enable dispatch.

Find the workflow run matching this tag and commit, record its URL, and wait for
packaging and publication to succeed. Inspect that run's logs on failure. Check
whether publication partially succeeded before retrying. Do not automatically
delete tags or releases as recovery.

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

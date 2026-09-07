# Shared-machine cloud tasks

In `FLOW_MODE=prod`, Flow runs OpenCode tasks on the existing Linux machine.
It uses the installed CLIs and their existing OS-user authentication. Each
Slack thread has a stable conversation identity and separate Git worktrees.

## Execution

Ordinary questions read shared source checkouts and do not acquire a coding
slot. Before creating an edit workspace, editing a file, or running a shell
command, the OpenCode plugin requests the machine's coding slot. Requests are
FIFO; another conversation can still answer questions while a coding task runs.
Slack displays when a task is waiting. Resumed direct edits also acquire the slot.
With exactly one owned worktree, Flow can fill in an omitted shell working
directory. A simple leading `cd <owned-tree> &&` is translated into that working
directory, never executed as a directory change. Ambiguous or external paths
are refused. If shell commands were attempted but none succeeded, Flow reports
unverified results instead of forwarding a model's unsupported success claim.
The default turn timeout is one hour, including time waiting for the slot;
`FLOW_CLOUD_TASK_TIMEOUT_MS` changes it. `SLACK_AGENT_ANSWER_TIMEOUT_MS`, when
set, provides a separate Slack-side timeout.

The queue lives in `~/.flow/coding/queue.db`, shared by all Flow projects run as
the same OS user. `FLOW_CODING_STATE_DIR` overrides its directory. Multiple
containers must mount the same queue directory **and share the PID namespace**
to coordinate this way; independent containers/OS users are not one worker.
Use a local disk, not a network filesystem, for the SQLite queue.

The slot lasts until the turn finishes, fails, or is cancelled and its process
group has stopped. Task descendants are stopped when the CLI exits, including
background servers in that process group. Linux crash recovery checks process
start identities before killing an orphan group and admitting a successor.
Live tasks do not lose the slot through an arbitrary lease timeout.

This is a trusted-team execution policy, not an OS security sandbox. Arbitrary
programs can bypass path restrictions or detach processes. Agents are instructed
to use foreground commands and local tool installs; direct daemon, Docker,
service-management and global-install commands are refused. Do not use this
mode for mutually untrusted tenants. Existing host authentication also means
commands have the host user's permissions and can affect external services.

## Conversation and Git state

Turns in the same conversation run serially. Follow-ups use the saved OpenCode
session. Git's per-worktree metadata directory and a Flow identity marker track
the actual tree, even after branch switches, detached HEAD, or `git worktree
move`. Paths/branches are reconciled on tool requests and at turn completion.
A missing or replaced tree fails closed rather than falling back to shared
source. Existing pre-upgrade worktrees adopt a marker on first reconciliation.

After an orchestrator restart, interrupted and queued cloud turns are marked
failed rather than silently replaying edits or external side effects. The next
Slack message resumes the saved conversation and worktrees. This initial version
does not promise automatic completion of a turn interrupted by a restart.

## Disk cleanup

An hourly sweep considers conversations inactive for 72 hours. Set
`FLOW_WORKTREE_IDLE_HOURS` to another positive hour count, or `0` to disable.
Active/queued conversations are skipped. Cleanup also requires the coding slot.

Flow builds a local checkpoint commit using a temporary Git index, stores it on
`flow/checkpoints/<conversation-hash>/<repo>`, records the checkpoint in SQLite,
then removes the linked worktree. Nothing is pushed. Original branches remain.
Conversations, jobs and session history are retained. On the next message Flow
recreates the worktree at the saved commit; a modified checkpoint branch is
rejected. Dependencies may need reinstalling.

Root `.env` and `.env.*` files are copied from the source checkout when a tree
is created/restored; they are not shared by symlink. Unchanged copied env files
can be discarded during cleanup, including when they were never gitignored.
They are excluded from new checkpoints. Already tracked files remain in Git's
existing history. Host CLI auth is inherited; a CLI installed locally by one
task does not automatically become available to other tasks.

Cleanup retains the whole worktree when it finds changed credentials, detected
tokens in changed files, conflicts, a Git operation in progress, partial staging,
submodules, large/special changed files, or unrecognized ignored files. Only
known dependency/build caches (`node_modules`, `.next`, `.nuxt`, `.turbo`,
`__pycache__`, `.pytest_cache`) are disposable by default. Secret detection is
best-effort, not a guarantee that arbitrary secrets can be recognized.

The `cloud_worktrees` row records `path`, `branch`, `git_dir`, `git_identity`,
`checkpoint_commit`, `archived_at`, and `cleanup_error`. Workspace tool responses
include this state. A retained tree needs inspection; Flow never resolves it by
blindly force-cleaning. Local checkpoint branches are retained indefinitely.

## Verification

`npm test --workspace orchestrator` includes the lifecycle tests. Set
`FLOW_TEST_OPENCODE_BIN` to an installed OpenCode binary to include the real
plugin smoke test. Run on Linux to exercise orphan process-group recovery.

## Legacy repository environment API

The old dashboard upload panel has been removed in favor of conversational setup
(described below). Existing stored files and `/v1/agents/repos/:repo/env` remain
supported for compatibility: `.env`, `.env.local`, or another `.env.*` file
(256 KiB maximum).
Files are scoped to that repository in that Flow project. The API lists names
and update times, never values. Uploading the same filename replaces its saved
version; Remove deletes the saved version. Store development/test credentials.

Contents use the same AES-256-GCM encryption as Flow settings, keyed from
`FLOW_ADMIN_TOKEN`. Back up that key alongside the DB; changing it without a
migration makes existing encrypted settings and env files unreadable. This is
protection for stored data, not isolation from administrators or task processes.
Every authenticated administrator of the project can replace these files.

When a coding turn acquires its workspace, Flow writes uploads into the appropriate
repo worktree with mode 0600. Uploads override source env copies. Applications
must load the files as usual; Flow does not execute shell code from env files
or globally export their contents. Changes during a run apply on a later turn.
If an agent/user modifies or deletes a managed env file, refresh fails and keeps
that state for inspection. Removing an upload restores the source version on
next refresh, or removes the unchanged uploaded copy if no source file exists.

Uploads are excluded from cleanup commits and restored from encrypted settings
when a tree is recreated. Known secret values and credential patterns are
redacted from the cloud run display and new transcript logs. Redaction is
best-effort: transformed values, short values, and previously stored logs can
still contain sensitive data. Never treat agent output as a secret boundary.

## Dashboard runs and commands

The server's Agents page shows Slack and dashboard conversations, their recent
turns, live activity, results, worktrees and queue status. Follow-ups preserve
the conversation; Cancel stops the selected queued/running turn. Follow-ups
submitted from the dashboard show their results there; Slack messages continue
to receive replies in Slack. The local-mode ACP Agents UI is unchanged.

The command panel runs a noninteractive Bash command in a selected task
worktree. It shares the coding queue, records output/exit status, and stops after
120 seconds. Its stdin is closed after the supplied command; interactive CLIs,
PTYs and persistent development servers are not supported in this first view.
Installed server CLIs use the server OS user's existing credentials. Commands
do not execute on a connected laptop. A local install inside a worktree remains
specific to that tree; a server administrator provisions shared tools.

Worktrees isolate source changes, not OS processes, ports, databases, browser
profiles or cloud resources. Use task-specific ports and test databases, avoid
production credentials, and do not run global setup or service management in
tasks. Authenticated port previews and strong process/filesystem isolation need
additional implementation; this release does not provide them.

Production workers reject legacy local-agent starts/prompts and direct worktree
mutation endpoints. The homepage links to cloud Agents instead of exposing the
local ACP composer. Historical local sessions remain readable and cancellable.

### Slack queue and coding delivery

When a coding task waits for the machine slot, Flow posts a persistent reply in
its Slack thread. It updates that reply when the slot is acquired and when the
turn finishes, fails or is stopped. Notifications are serialized and independent
of Slack's optional assistant-status support; a Slack API failure is logged and
does not fail the coding task. Ordinary questions do not post queue notices.

Coding agents are instructed to deliver requested changes with a reviewed diff,
relevant checks, a commit, and a PR, unless the user requests otherwise. Follow-ups
update the task's existing PR. PR publication requires GitHub CLI (`gh`) installed
and authenticated on the server, with push and PR permissions. Missing credentials
or tools must be reported as concrete blockers, not as completed delivery.
UI tasks should include inspected screenshots when browser tooling and an
accessible evidence-delivery mechanism are available; local paths alone are not
Slack attachments. These are agent instructions, not proof that a PR or test exists.

Cloud subprocesses receive a Git author/committer identity without modifying the
shared Git configuration. Existing `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment
values are respected; otherwise `FLOW_GIT_AUTHOR_NAME` and `FLOW_GIT_AUTHOR_EMAIL`
configure the identity, defaulting to `Flow <flow@localhost>`. Configure a real bot
identity when repository policy requires a recognized author.

Set `FLOW_PUBLIC_URL` in the project's server `.env` to the full public dashboard
URL (for example, `https://flow.example/team`). Coding start/queue replies and final
answers include a “View agent run” link into the existing Agents UI. Authentication
is still required by the dashboard; links contain no credentials. If the public
URL is absent or invalid, Flow omits links instead of inventing an inaccessible URL.
Read-only follow-ups to an existing coding conversation retain the run link without
a new coding-start notice. Shell pipelines run with `pipefail` so output filtering
cannot silently turn a failed verification command into a successful one.

### Slack image input

Slack messages and mentions can include PNG, JPEG, GIF or WebP images, including
image-only messages. Enable the bot's `files:read` scope and reinstall existing
Slack apps after upgrading; new manifests include it. Flow downloads files with
the server's bot token, verifies the image signature, and passes private local
attachments to OpenCode's multimodal input. The selected model must support vision.
The Slack token and private download URLs are never included in model prompts.

Files live outside repository worktrees in the project's workspace under
`.flow-slack-images`, separated by workspace/channel/thread, with 0600 permissions.
The most recent five images are attached again on follow-ups, including after a
restart or worktree cleanup. Limits: five images per message, 5 MiB per image,
and twenty stored images per thread. Start a new thread when that storage limit
is reached. Stored images are retained with the conversation; no automatic image
retention cleanup is implemented yet. Unsupported attachments and inaccessible
files produce a visible error rather than a text-only answer pretending to see them.

## Conversational setup

The dashboard no longer has a repository env-upload panel. In cloud Slack tasks,
`flow_setup` lets the agent list saved setup, register an existing untracked file
without reading its values, select an environment, or request a missing file,
variable, or CLI setup from the original requester. Paths can be nested and files
can have any name; each supplied file is limited to 1 MiB. Tracked files, Git
metadata, traversal and symlink destinations are refused.

A request opens a dedicated DM thread with the original requester. File/value
replies are consumed by the setup handler before normal chat/image processing.
Only the requester in the matching Slack workspace and DM thread can fulfill it.
Raw values and files do not enter job prompts; files are stored encrypted with the
project settings key. Slack itself retains the original attachment/message.

The agent turn ends while waiting, releasing the machine coding slot. Requests
survive restarts. Once fulfilled, a worker takes that slot to register files in
both the source checkout and the task worktree, then resumes the same conversation
and delivers the result to the original Slack thread. The resume job is deduplicated
by request ID. Upload/network failures leave the request pending. Conflicting
locally changed files are retained instead of overwritten. A requester can reply
`cancel` in the setup DM thread to cancel a waiting request.

Saved setup is keyed by repository, environment and destination. Environment
selection sticks to each conversation; a single non-production environment can
be reused automatically, while production requires explicit selection. Copies
are mode 0600, excluded in Git's local exclude file, hidden from cloud diffs, and
restored for future worktrees. This is coordination on a trusted shared host,
not OS isolation; authenticated terminals and programs can access host files.
Normal application loaders must load env files; values are not automatically
exported into every shell. Register only reusable configuration, not databases,
Terraform state or caches. Modified private setup keeps worktrees from being
checkpointed automatically.

Terminal requests link to an authenticated project dashboard page backed by
node-pty and xterm.js. It starts a login shell as the Flow OS user in the source
checkout and holds the same coding slot as agents. CLI installations and saved
logins persist; shell-only exports do not. Terminal input/output is held only in
bounded memory, never stored in the agent transcript. Closing the terminal
releases its slot; “Done — resume task” also fulfills the setup request. The agent
must verify the setup after resuming. Disconnected terminals close after five
minutes without polling/input, and terminals have a one-hour maximum lifetime.
A restart ends the terminal; the DM link can reopen it. Linux builds need the
native build prerequisites for node-pty (Python and a C/C++ toolchain).

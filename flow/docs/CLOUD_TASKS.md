# Cloud conversations and worktrees

With `FLOW_MODE=prod`, interactive cloud tasks use OpenCode exclusively. One
conversation answers questions and implements changes across any number of
registered repositories. There is no separate question/coding classifier or
agent handoff. Local mode keeps its existing ACP backends and placement choices.

## Entry points

The active Slack agent's FlowRuntime submits questions, edit requests, and
follow-ups to the same cloud conversation using team/channel/thread identity.
The first turn reserves the conversation before OpenCode starts. Slack's stop
action and superseding replies cancel the prior coding job, including when it
is still queued, and preserve its recorded session/worktrees for the next turn.
Timeouts also cancel execution. The legacy event adapter retains its stable
delivery IDs and duplicate-mention guard for callers using that path.

Other adapters (Teams, webhooks, schedulers) can submit this authenticated API
contract without Slack-specific fields:

```http
POST /v1/agents/tasks
Authorization: Bearer <project admin token>
Content-Type: application/json

{
  "conversation": { "source": "teams", "workspace": "tenant-id", "id": "thread-id" },
  "message": "Explain payment retries"
}
```

The response is `{ "id": "<job-id>", "backend": "opencode" }` (202). Poll
`GET /v1/jobs/:id` for status and `result_json`; the adapter owns delivery to its
origin. Reuse the same conversation identity on subsequent turns. The project
DB provides project isolation; `source`, `workspace`, and `id` distinguish
conversations within that project. These are adapter identifiers, not user
authorization claims. New public adapters must authenticate their callers
before invoking this trusted API. This change does not install a Teams adapter.

Cloud tasks do not use `/v1/agents/sessions`, the local ACP dashboard API. That
creation/resume path is refused in prod to prevent bypassing the cloud guard.
`/v1/ask` and Slack already use the shared job runner.

## Lazy workspace lifecycle

1. A question uses the graph plus OpenCode read/grep/glob tools over registered
   clones under `workspace/repos/`. No clone or worktree is created for a question.
2. When edits are needed, `flow_workspace({repo, edit:true})` creates a Git
   worktree from the registered base branch's exact cached commit. It never
   switches or resets the primary checkout. An unavailable base is an error.
3. The worktree is recorded in SQLite by conversation and repo. Concurrent
   creation calls share one result. Additional repos are discovered and prepared
   as needed; unknown repo names and arbitrary filesystem paths are rejected.
4. OpenCode reads the new files, edits, and runs commands in that worktree.
   Turns within a conversation run sequentially; unrelated conversations can
   run concurrently. Follow-ups reuse the OpenCode session and worktrees.
5. Session IDs are saved as soon as OpenCode emits them. On restart, interrupted
   and queued cloud jobs are marked failed, without replaying edits. A follow-up
   resumes the stored session. Missing worktrees fail rather than replacing work.

Creation uses the existing worktree helper, including independent copies of
root `.env*` files. Cloud creation skips the potentially large `node_modules`
copy; dependencies can be installed in the worktree when needed. Processes use
the deployment's existing CLI installations and ambient authentication. Laptop
logins are not imported to EC2. No sandbox service or extra machines are added.

## Before-execution policy

The runner injects an OpenCode plugin by absolute file URL. Its
`tool.execute.before` hook checks every exposed tool call. Permissions begin
denied and are enabled by the plugin's configuration hook, so a plugin that
fails to load cannot leave edits or shell execution enabled.

- Direct write/edit/apply_patch against a shared clone is stopped before any
  edit. Flow prepares the worktree and returns its path; the agent must re-read
  and retry there. Patch checks include deletions and rename destinations.
- Subsequent reads of source paths follow this conversation's existing tree.
- File tools reject paths outside registered source/owned worktree directories,
  symlink escapes, Git metadata, and credential files.
- Shell calls require an explicit owned worktree `workdir`. Direct directory
  changes, source-checkout targets, and Git branch/administration overrides are
  refused. Tests and installs run from the selected worktree.
- Unknown tools, delegated subagents, and direct graph mutations are refused.
  Graph lookup, advisory corrections, memory, and progress notifications remain.

This is a tool policy, not an OS security boundary. A script invoked by an
allowed shell command has the host account's permissions and can access files
outside the worktree. Thus "never modify the primary checkout" is enforced for
guarded file operations and ordinary direct commands, not arbitrary executable
code. Stronger enforcement requires the later sandbox layer. Shared Git object
and worktree metadata are necessarily written by Flow's worktree manager.

The workspace RPC accepts only the token for that running job and derives its
conversation from the stored job. It cannot be used to select another thread.
Publishing can use existing host Git/GitHub CLI authentication from the task
branch; this change does not add automatic merges or a new privileged publisher.

## Verification

The normal orchestrator suite includes real-Git workspace/policy tests and
adapter/job tests. An optional smoke test drives the installed OpenCode binary
against a deterministic local model endpoint, without paid model calls:

```sh
FLOW_TEST_OPENCODE_BIN="$(command -v opencode)" npm test --workspace orchestrator
```

The plugin API is pinned to OpenCode 1.17.20. The smoke test checks actual plugin
loading, rejection of a shared-clone write, and a successful worktree write.

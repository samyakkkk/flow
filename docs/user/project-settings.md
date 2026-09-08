# Project settings

Open **Settings → Projects**. The project and machine pickers start at **All projects** and
**All machines**.

Change the default model, workspace, automatic pull, agent browser access, or actions for projects that inherit those values.
Select an individual project to override a default. Reset its row to inherit again. Changing a
default preserves explicit project overrides. Workspace preferences in `t3.json` take precedence
over machine defaults when the project has no explicit workspace override.

Select a machine to limit edits to it. **All machines** writes defaults to connected machines;
offline machines keep their previous values. Mixed values are indicated when selected machines
or checkouts disagree. Browser access changes apply when an agent session next starts.

Project grouping has a client-wide default across machines, with individual checkout overrides.
Shared actions apply to inheriting projects; editing a project's actions creates an independent list.
Reset that list to use shared actions again. Existing project actions are preserved.

Project names, icons, removal, and importing actions from a checkout remain project-specific.
When there are several checkouts, the checkout picker selects which actions and grouping to edit.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to selected checkouts in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

## Connected Flow brain

Choose a brain for the project to give its chats Flow's graph, memory, and committed-source
access. The next regular message automatically supplies Flow's orientation, including in an
existing chat. Chats receive the original Flow tools without a separate skill or MCP installation.

Orientation refreshes after an agent session restarts, after compaction, or when you change the
connected brain. It is not repeated on every message. Disconnecting stops further reads and
capture, but cannot erase knowledge already in the conversation; start a new chat for a clean context.

Flow captures user messages, assistant output, and tool activity for its existing memory pipeline.
Capture is stored locally before background processing and retried if the brain worker is unavailable.
Distillation uses Flow's existing LLM configuration; a usable transport is required to process
checkpoints. Indexed sources may be older than the current checkout, and incomplete indexing
can limit what the brain knows.

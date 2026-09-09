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

Select a project in **Settings → Projects**. The **Brain** section at the top shows its current
brain. Choose another brain, use **New brain** to create and connect one, or select **No brain**
to disconnect. One brain is shared by all checkouts of the same repository, including checkouts
added later. If older checkouts used different brains, choose one for the project to resolve the conflict.

In a chat with no connected brain, you can also use **Connect brain** in the Flow side panel
to choose or create one for the project. Before the first message in an unconfigured project,
Flow offers the same choice. **Continue without a brain** is remembered for the project across
chats and devices. Chats then run without Flow orientation or memory capture; you can connect
a brain later from the side panel or project settings.

Choose a brain for the project to give its chats Flow's graph, memory, and committed-source
access. The next regular message automatically supplies Flow's orientation, including in an
existing chat. Chats receive the original Flow tools without a separate skill or MCP installation.

Orientation refreshes after an agent session restarts, after compaction, or when you change the
connected brain. It is not repeated on every message. Disconnecting stops further reads and
capture, but cannot erase knowledge already in the conversation; start a new chat for a clean context.

### Conversation notes, memories, and skills

The chat's **Flow** panel starts conversation notes with your first message. As you work,
Flow maintains a readable account of the task, progress, corrections, and unfinished work so
an agent can recover after compaction. Your agent can retrieve it with `get_chat_memories`.

The same background process learns reusable memories and skills from the conversation and
its recorded tool evidence. Memories capture decisions, preferences, lessons, and useful
context. Skills describe procedures that were actually demonstrated, such as reproducing a
failure and verifying its fix. Related skills are refined as later conversations add evidence.
Notes always have a section; memories and skills appear when the chat has contributed them.

Notes update after completed turns and about every 60 seconds while new activity arrives.
Busy extraction coalesces later activity into a follow-up. The panel shows pending work or an
extraction error rather than reporting that unavailable processing succeeded. Captured activity
is retained locally for retry; incomplete or truncated tool output can limit the conclusions.

Automatic extraction uses an enabled Codex provider signed in with a ChatGPT subscription,
independently of the provider used for the main conversation. Background sessions do not
appear in your T3 chat list or Codex conversation history. They reuse context between
checkpoints and renew it as it grows, retaining saved notes and access to earlier evidence.
`FLOW_DISTILLER=0` disables automatic extraction in the brain runtime.

### Find and use what your brain learned

Open **Brain** and choose **Auto-Skills** or **Memories** to browse what the connected brain
has learned. **Knowledge Graph** contains its code map and source connections. Search by
name or purpose and open a document to read it fully. **Updated** is when the document was
edited; **Evidence from** is when its newest supporting conversation evidence was recorded.
Older procedures can depend on an earlier branch or runtime, so check their stated scope.
Time-sensitive memories become less prominent with age; lasting rules and useful fixes remain.

Open a skill and choose **Copy chat prompt** to ask your agent to read and use its latest
version in a chat connected to that brain. You can also ask for a skill by purpose: orientation
includes a skill catalog, and agents can use `list_skills` and `read_skill` to find the full
procedure. **Download SKILL.md** saves a portable copy. Downloading does not install the skill
into a provider's local skill directory or slash menu.

The chat panel and Brain page read from the selected brain. Switching brains changes the
available documents; disconnecting stops further capture and reads. Indexed source references
may describe an older revision than the current checkout.

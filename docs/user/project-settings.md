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

Flow captures user messages, assistant output, and tool activity for its existing memory pipeline.
Capture is stored locally before background processing and retried if the brain worker is unavailable.
Distillation uses Flow's existing LLM configuration; a usable transport is required to process
checkpoints. Indexed sources may be older than the current checkout, and incomplete indexing
can limit what the brain knows.

The chat page's **Flow** panel shows the connected graph and a simple list of memories extracted
from that conversation. Notes appear after turns and background checkpoints, not after every token.
Memories start expanded in the floating Flow card. Expand the brain or any memory to read it in full. Your agent can call `get_chat_memories` to retrieve the same
chat's saved notes, including after compaction. The list is read from the currently connected brain;
changing brains changes which saved notes are available. Unavailable or disabled extraction is shown
in the panel rather than presented as successful saving.

### Live chat memories

For chats with a connected brain, Flow extracts memories after the first completed response and each subsequent response (a two-second debounce). During longer responses it also schedules extraction after 30 seconds when at least 400 new text characters have accumulated. Tool traffic alone does not trigger that timer. One extraction runs per chat, with later arrivals coalesced into a follow-up. The five-minute checkpoint sweep remains the retry/recovery path.

Hosted extraction uses the fast model tier: Claude Haiku for the Claude CLI, or the configured `LLM_MODEL_FAST` for the API transport. `DISTILLER_MODEL` overrides the extraction model. Extraction transport is independent of the chat provider and uses the existing `LLM_TRANSPORT` setting. `FLOW_DISTILLER=0` disables automatic extraction in the brain runtime.

The extractor sees new transcript events, recent preceding context, and existing chat notes. It may add a note, replace a corrected note, retract a note, or return no changes. Every change requires new transcript evidence; replacements and retractions can only target notes in this chat. Prior observations remain in the brain's history; the chat memory tool and card show the current notes.

The card receives changes through authenticated long polling (up to 20 seconds per request, returning early when memories/status change), displays extraction state, and briefly highlights saved changes. A completed extraction with no useful notes does not show a fake saved-memory notification.

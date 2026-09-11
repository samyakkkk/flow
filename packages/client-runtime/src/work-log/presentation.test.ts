import { BRAND } from "@t3tools/shared/branding";
import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import {
  commandDetailRepeatsCommand,
  extractCommandOutputText,
  formatFlowBrainToolCallValue,
  resolveFlowBrainConsultationDisplay,
  resolveFlowBrainToolCallDetails,
  resolveViewedImageAsset,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  type WorkLogPresentationEntry,
  workEntryViewedImagePath,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "./presentation.js";

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it("is true for error tone", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "error",
        detail: "nothing special",
      }),
    ).toBe(true);
  });

  it("is true when lifecycle says failed even if detail is empty", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "failed",
      }),
    ).toBe(true);
  });

  it("detects file-not-found style tool output with completed lifecycle", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "File not found: C:\\foo\\nonexistent.ts",
      }),
    ).toBe(true);
  });

  it("detects glob no files and PowerShell command errors", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Glob",
        tone: "tool",
        detail: "No files found",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Bash",
        tone: "tool",
        detail:
          "The term 'this_is_not_a_command' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      }),
    ).toBe(true);
  });

  it("is false for successful completed tools", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "Found 3 matching files",
      }),
    ).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
    // Older activities can store output in this field, so that path stays separate.
    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });

  it("treats successful tool rows as success candidates", () => {
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "ok",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "inProgress",
        detail: "…",
      }),
    ).toBe(false);
    expect(workEntryIndicatesToolSuccess({ ...base, tone: "thinking", detail: "…" })).toBe(false);
    expect(
      workEntryIndicatesToolSuccess({ ...base, tone: "tool", toolLifecycleStatus: "stopped" }),
    ).toBe(false);
  });

  it("does not run heuristics on non-tool info rows", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Context compacted",
        tone: "info",
        detail: "File not found in conversation",
      }),
    ).toBe(false);
  });
});

describe("summarizeToolGroup", () => {
  it.each(["command", "file-read", "file-change"])(
    "keeps %s approvals out of tool execution counts",
    (requestKind) => {
      const approvals = [
        {
          label: "Approval requested",
          sourceActivityKind: "approval.requested",
          tone: "info",
          requestKind,
        },
        {
          label: "Approval resolved",
          sourceActivityKind: "approval.resolved",
          tone: "info",
          requestKind,
        },
        {
          label: "Provider approval response failed",
          sourceActivityKind: "provider.approval.respond.failed",
          tone: "error",
        },
      ] satisfies WorkLogPresentationEntry[];

      expect(
        summarizeToolGroup([
          ...approvals,
          { label: "Read", tone: "tool", itemType: "dynamic_tool_call" },
        ]),
      ).toBe("Received 3 updates and used 1 tool");
      expect(summarizeToolGroup(approvals)).toBe("Received 3 updates");
      expect(toolGroupSummaryKind(approvals)).toBe("update");
    },
  );

  it("deduplicates named sources ahead of ordinary actions", () => {
    const source = { key: "browser-use:chrome", name: "Chrome", kind: "integration" as const };
    expect(
      summarizeToolGroup([
        { label: "Open page", tone: "tool", toolSource: source },
        { label: "Inspect page", tone: "tool", toolSource: source },
        {
          label: "Ran command",
          tone: "tool",
          itemType: "command_execution",
          command: "git status",
        },
      ]),
    ).toBe("Used Chrome integration and ran 1 command");
  });

  it("omits the integration suffix for special browser and computer sources", () => {
    expect(
      summarizeToolGroup([
        {
          label: "Inspect page",
          tone: "tool",
          toolSource: { key: "browser-use", name: "Browser", kind: "browser" },
        },
        {
          label: "Click",
          tone: "tool",
          toolSource: { key: "computer-use", name: "Computer Use", kind: "computer" },
        },
      ]),
    ).toBe("Used Browser and Computer Use");
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it.each([
    "mcp__t3-code__preview_click",
    "mcp__t3_code__preview_click",
    "mcp__t3code__preview_click",
    "T3-code.preview_click",
    "t3-code · preview_click completed",
    "t3_code/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "t3-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it.each([
    ["inProgress", "Clicking in the preview browser"],
    ["completed", "Clicked in the preview browser"],
    ["failed", "Failed to click in the preview browser"],
    ["declined", "Declined to click in the preview browser"],
    ["stopped", "Stopped clicking in the preview browser"],
    ["unknown", "Clicking in the preview browser"],
  ])("describes the tool's own %s state", (toolLifecycleStatus, displayName) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "T3-code.preview_click",
        toolLifecycleStatus,
      }),
    ).toEqual({ displayName, icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "T3-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "Clicking in the preview browser",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "Clicked in the preview browser",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked in the preview browser");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click in the preview browser");
  });

  it.each([
    ["preview_type", "Typing in the preview browser", "Typed in the preview browser"],
    [
      "preview_set_appearance",
      "Setting preview browser appearance",
      "Set preview browser appearance",
    ],
    [
      "preview_snapshot",
      "Taking a snapshot of the preview page",
      "Took a snapshot of the preview page",
    ],
    [
      "preview_recording_stop",
      "Stopping recording the preview browser",
      "Stopped recording the preview browser",
    ],
    ["t3_thread_read", `Reading a ${BRAND.shortName} thread`, `Read a ${BRAND.shortName} thread`],
    [
      "t3_thread_send",
      `Sending to a ${BRAND.shortName} thread`,
      `Sent to a ${BRAND.shortName} thread`,
    ],
    [
      "t3_worktree_handoff",
      "Handing off thread to a git worktree",
      "Handed off thread to a git worktree",
    ],
  ])("preserves verb forms and the rest of %s's label", (tool, running, completed) => {
    const entry = { label: `t3-code.${tool}` };
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "inProgress" })
        ?.displayName,
    ).toBe(running);
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" })?.displayName,
    ).toBe(completed);
  });

  it("keeps T3 branding for non-browser tools and falls back to the original tool label", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "mcp__t3_code__task_status",
        toolTitle: "Check the child task",
      }),
    ).toEqual({ displayName: "Getting delegated task status", icon: "t3-code" });
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "t3-code.unknown_tool",
      "t3-code.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});

describe("Flow brain MCP presentation", () => {
  const brainEntry = {
    label: "MCP tool call",
    tone: "tool",
    itemType: "mcp_tool_call",
    toolLifecycleStatus: "completed",
    toolData: {
      type: "mcpToolCall",
      server: "flow-graph",
      tool: "find_entity",
      arguments: { qs: ["tool activity rendering"] },
      result: { content: '{"status":"batch","count":1}' },
    },
  } satisfies WorkLogPresentationEntry;

  it("presents Flow MCP calls as brain consultations", () => {
    expect(resolveWorkEntryToolPresentation(brainEntry)).toEqual({
      displayName: "Consulted the brain · Find entity",
      icon: "brain",
    });
    expect(
      resolveWorkEntryToolPresentation({ ...brainEntry, toolLifecycleStatus: "inProgress" }),
    ).toEqual({
      displayName: "Consulting the brain · Find entity",
      icon: "brain",
    });
    expect(toolGroupAction(brainEntry)).toBe("brain");
    expect(toolGroupSummaryKind([brainEntry])).toBe("brain");
  });

  it("recognizes Flow verbs exposed through the t3-code MCP server", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "MCP tool call",
        toolData: { toolName: "mcp__t3_code__orient", input: { repo: "flow" } },
      }),
    ).toEqual({
      displayName: "Consulting the brain · Orient",
      icon: "brain",
    });
    expect(
      resolveWorkEntryToolPresentation({
        label: "MCP tool call",
        toolData: { server: "github", tool: "find_entity" },
      }),
    ).toBeNull();
  });

  it("shows discovered skills and their complete procedure as Brain consultations", () => {
    const skill = {
      id: "skill-1",
      kind: "skill",
      name: "Verify name normalization",
      description: "Run the focused whitespace regression.",
      revision: 2,
      text: "---\nname: verify-name\ndescription: Focused regression\n---\n\nRun `node --test normalize-name.test.mjs`. Expect one passing test.",
    };
    const entry = {
      ...brainEntry,
      toolData: {
        server: "t3-code",
        tool: "read_skill",
        arguments: { id: skill.id },
        result: { content: [{ type: "text", text: JSON.stringify(skill) }] },
      },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Consulted the brain · Read skill",
    );
    const display = resolveFlowBrainConsultationDisplay(entry);
    expect(display?.requestFields).toEqual([{ label: "Skill", value: skill.id }]);
    expect(display?.responseSections[0]?.text).toContain("node --test normalize-name.test.mjs");
    expect(display?.responseSections[0]?.text).not.toContain("description:");
    const listed = resolveFlowBrainConsultationDisplay({
      ...entry,
      toolData: {
        ...entry.toolData,
        tool: "list_skills",
        arguments: {},
        result: { content: [{ type: "text", text: JSON.stringify([skill]) }] },
      },
    });
    const batch = resolveFlowBrainConsultationDisplay({
      ...entry,
      toolData: {
        ...entry.toolData,
        tool: "get_entity",
        arguments: { ids: [skill.id, "missing"] },
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "batch",
                found: 1,
                results: [
                  { id: skill.id, status: "found", document: skill },
                  { id: "missing", status: "not_found" },
                ],
              }),
            },
          ],
        },
      },
    });
    expect(batch?.responseSections[0]?.items?.[0]).toMatchObject({
      title: skill.name,
      eyebrow: "SKILL.md",
      tags: ["Revision 2"],
    });
    expect(batch?.responseSections[0]?.items?.[0]?.description).toContain(
      "node --test normalize-name.test.mjs",
    );
    expect(batch?.responseSections[0]?.items?.[1]?.tone).toBe("warning");
    expect(listed?.responseSummary).toBe("1 skill");
    expect(listed?.responseSections[0]?.items?.[0]).toMatchObject({
      id: skill.id,
      title: skill.name,
      eyebrow: "SKILL.md",
    });
    expect(
      resolveWorkEntryToolPresentation({
        ...entry,
        toolData: { ...entry.toolData, server: "unrelated" },
      }),
    ).toBeNull();
  });

  it("extracts and formats the request and response without provider metadata", () => {
    const details = resolveFlowBrainToolCallDetails(brainEntry);
    expect(details).toEqual({
      tool: "find_entity",
      toolLabel: "Find entity",
      request: { qs: ["tool activity rendering"] },
      response: { status: "batch", count: 1 },
    });
    expect(formatFlowBrainToolCallValue(details?.request, "No parameters")).toBe(
      '{\n  "qs": [\n    "tool activity rendering"\n  ]\n}',
    );
    expect(formatFlowBrainToolCallValue(details?.response, "No response body")).toBe(
      '{\n  "status": "batch",\n  "count": 1\n}',
    );
  });

  it("falls back to text content when MCP structured content is null", () => {
    const details = resolveFlowBrainToolCallDetails({
      ...brainEntry,
      toolData: {
        type: "mcpToolCall",
        server: "flow-graph",
        tool: "orient",
        arguments: { repo: "flow" },
        result: {
          _meta: null,
          content: [
            {
              type: "text",
              text: 'CONNECTED PROJECT: "Flow"\n[flow orient — repo "flow" @ main-v2]',
            },
          ],
          structuredContent: null,
        },
      },
    });

    expect(details?.response).toBe(
      'CONNECTED PROJECT: "Flow"\n[flow orient — repo "flow" @ main-v2]',
    );
  });

  it("projects batched entity searches into query groups and readable result cards", () => {
    const display = resolveFlowBrainConsultationDisplay({
      ...brainEntry,
      toolData: {
        ...brainEntry.toolData,
        arguments: { qs: ["auth middleware", "personal access tokens"], limit: 5 },
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "batch",
                count: 2,
                groups: [
                  {
                    query: "auth middleware",
                    status: "similar",
                    matches: [
                      {
                        type: "Handler",
                        id: "handler:auth",
                        name: "Authentication middleware",
                        description: "Checks the session before routing.",
                        anchor: "apps/server/src/auth.ts:12",
                        via: "vector",
                      },
                    ],
                    memory_hits: [
                      "[Memory:decision] Sessions are checked on every request. (strong) [mem:abc]",
                    ],
                  },
                  {
                    query: "personal access tokens",
                    status: "none",
                    matches: [],
                  },
                ],
              }),
            },
          ],
        },
      },
    });

    expect(display).toMatchObject({
      toolLabel: "Find entity",
      requestFields: [
        { label: "Queries", value: ["auth middleware", "personal access tokens"] },
        { label: "Result limit", value: "5" },
      ],
      responseSummary: "1 entity · 1 memory · 2 queries",
      responseSections: [
        {
          title: "auth middleware",
          subtitle: "Similar",
          items: [
            {
              eyebrow: "Handler",
              title: "Authentication middleware",
              id: "handler:auth",
              description: "Checks the session before routing.",
              fields: [{ label: "Code", value: "apps/server/src/auth.ts:12", code: true }],
              tags: ["Semantic match"],
            },
            {
              eyebrow: "Memory · Decision · Strong",
              title: "Sessions are checked on every request.",
              id: "mem:abc",
            },
          ],
        },
        { title: "personal access tokens", subtitle: "None", items: [] },
      ],
    });
  });

  it("turns knowledge-search prose into one card per memory", () => {
    const display = resolveFlowBrainConsultationDisplay({
      ...brainEntry,
      toolData: {
        server: "flow-graph",
        tool: "search_knowledge",
        arguments: { query: "auth sessions" },
        result: {
          content: JSON.stringify({
            status: "ok",
            results:
              "MEMORY:\n- Auth uses signed cookies. [decision/strong] (memory 123)\n- Local mode is open. [gotcha/medium] (memory 456)",
          }),
        },
      },
    });

    expect(display).toMatchObject({
      requestFields: [{ label: "Query", value: "auth sessions" }],
      responseSummary: "2 memories",
      responseSections: [
        {
          title: "Matches",
          items: [
            {
              eyebrow: "Memory · Decision · Strong",
              title: "Auth uses signed cookies.",
              id: "123",
            },
            { eyebrow: "Memory · Gotcha · Medium", title: "Local mode is open.", id: "456" },
          ],
        },
      ],
    });
  });

  it("counts brain consultations separately from commands and generic tools", () => {
    expect(
      summarizeToolGroup([
        brainEntry,
        { ...brainEntry, toolCallId: "brain-2" },
        {
          label: "Ran command",
          tone: "tool",
          itemType: "command_execution",
          command: "git status",
        },
      ]),
    ).toBe("Consulted the brain 2 times and ran 1 command");
  });
});

describe("browser group summaries", () => {
  const browserEntry: WorkLogPresentationEntry = {
    label: "MCP tool call",
    toolData: { server: "t3-code", tool: "preview_click" },
    itemType: "mcp_tool_call",
    toolLifecycleStatus: "completed",
    tone: "tool",
  };
  const commandEntry: WorkLogPresentationEntry = {
    label: "Ran command",
    command: "/bin/bash -lc 'vp test run'",
    itemType: "command_execution",
    toolLifecycleStatus: "completed",
    tone: "tool",
  };

  it.each([1, 18])("counts %s browser calls separately from generic tools", (count) => {
    const entries = Array.from({ length: count }, (_, index) => ({
      ...browserEntry,
      toolCallId: `browser-${index}`,
    }));
    expect(summarizeToolGroup(entries)).toBe(
      `Used browser ${count} ${count === 1 ? "time" : "times"}`,
    );
    expect(toolGroupSummaryKind(entries)).toBe("browser");
  });

  it("combines command and browser counts in a single sentence", () => {
    const entries = [
      ...Array.from({ length: 4 }, () => commandEntry),
      ...Array.from({ length: 15 }, () => browserEntry),
    ];
    expect(summarizeToolGroup(entries)).toBe("Ran 4 commands and used browser 15 times");
    expect(toolGroupSummaryKind(entries)).toBe("mixed");
  });

  it("preserves first-seen action ordering alongside non-browser tools", () => {
    expect(
      summarizeToolGroup([
        browserEntry,
        commandEntry,
        {
          ...browserEntry,
          toolData: { server: "t3-code", tool: "task_status" },
        },
      ]),
    ).toBe("Used browser 1 time, ran 1 command, and used 1 tool");
  });

  it("recognizes Claude browser identity without treating script metadata as a shell command", () => {
    expect(
      summarizeToolGroup([
        {
          ...browserEntry,
          command: "node inspect-page.js",
          toolData: { toolName: "mcp__t3_code__preview_evaluate" },
        },
      ]),
    ).toBe("Used browser 1 time");
  });

  it("keeps foreign tools and web searches out of the browser count", () => {
    expect(
      summarizeToolGroup([
        browserEntry,
        {
          ...browserEntry,
          label: "preview_click",
          toolData: { server: "another-server", tool: "preview_click" },
        },
        { label: "Search", tone: "tool", itemType: "web_search" },
      ]),
    ).toBe("Used browser 1 time, used 1 tool, and searched the web 1 time");
  });

  it("keeps browser screenshots in the browser count while preserving their image path", () => {
    const entry = { ...browserEntry, viewedImagePath: "/workspace/page.png" };
    expect(summarizeToolGroup([entry])).toBe("Used browser 1 time");
    expect(workEntryViewedImagePath(entry)).toBe("/workspace/page.png");
  });
});

describe("command work-log details", () => {
  it("extracts Claude result blocks and projected output", () => {
    expect(
      extractCommandOutputText({
        result: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      }),
    ).toBe("first\nsecond");
    expect(extractCommandOutputText({ rawOutput: { content: "projected summary" } })).toBe(
      "projected summary",
    );
  });

  it("only removes a detail with the matching tool-name prefix", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello",
        command: "printf hello",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf hello" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "warning: printf hello",
        command: "printf hello",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf hello" },
      }),
    ).toBe(false);
  });

  it("treats an ingestion-truncated echo of a long command as a repeat", () => {
    const command = `git add -A && git commit -m "${"x".repeat(200)}"`;
    const truncated = `Bash: ${command}`.slice(0, 177) + "...";
    expect(
      commandDetailRepeatsCommand({
        detail: truncated,
        command,
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello...",
        command: "printf goodbye",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf goodbye" },
      }),
    ).toBe(false);
  });

  it("treats ACP command echoes as synthetic even without a tool kind", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { toolCallId: "tool-1", command: "pnpm test" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { command: "pnpm test" },
      }),
    ).toBe(false);
  });
});

describe("workEntryViewedImagePath", () => {
  const entry = { label: "Read", tone: "tool" } as const;

  it("returns a single image path from supported read entries", () => {
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: " assets/a.png " }),
    ).toBe("assets/a.png");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool_call",
        toolTitle: "Read file",
        detail: "C:\\workspace\\a.webp",
      }),
    ).toBe("C:\\workspace\\a.webp");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        viewedImagePath: " /workspace/reference image.webp ",
      }),
    ).toBe("/workspace/reference image.webp");
  });

  it("rejects non-image, multi-line, and non-read details", () => {
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.txt" }),
    ).toBeNull();
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.png\nb.png" }),
    ).toBeNull();
    expect(workEntryViewedImagePath({ ...entry, detail: "a.png" })).toBeNull();
  });
});

describe("toolGroupAction", () => {
  it("groups legacy Claude image reads with other reads", () => {
    expect(
      toolGroupAction({
        label: "Tool call",
        tone: "tool",
        itemType: "dynamic_tool_call",
        viewedImagePath: "/workspace/reference.png",
      }),
    ).toBe("read");
  });
});

describe("resolveViewedImageAsset", () => {
  const threadId = ThreadId.make("thread-1");

  it("serves t3 attachment paths in place like any other host path", () => {
    const path = "/Users/demo/.t3/dev/attachments/11111111-1111-4111-8111-111111111111.png";
    expect(resolveViewedImageAsset(path, { threadId, workspaceRoot: "/workspace" })).toEqual({
      resource: { _tag: "media-file", threadId, path },
      alt: "11111111-1111-4111-8111-111111111111.png",
      srcFragment: "",
    });
  });

  it("normalizes workspace image sources", () => {
    expect(
      resolveViewedImageAsset("screens/logo.svg?v=2#mark", {
        threadId,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      resource: {
        _tag: "media-file",
        threadId,
        path: "/workspace/screens/logo.svg",
      },
      alt: "logo.svg",
      srcFragment: "#mark",
    });
    expect(resolveViewedImageAsset("https://example.com/logo.png", { threadId })).toBeNull();
  });
});

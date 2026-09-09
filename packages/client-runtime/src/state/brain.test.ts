import type { BrainResponse, ChatMemoryList } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { retainChatContextOnError } from "./brain.ts";

function reply(workspaceId: string | null, error: string | null = null): BrainResponse {
  return {
    error,
    createdWorkspaceId: null,
    state: {
      database: { status: "ready", message: "Ready" },
      embeddings: { status: "idle", message: "Idle" },
      github: { connected: false, login: "", message: "Disconnected" },
      clis: [],
      workspaces: workspaceId
        ? [
            {
              id: workspaceId,
              name: workspaceId,
              cli: "codex",
              sources: [],
              knowledge: { entities: [], edges: [], memories: [] },
            },
          ]
        : [],
    },
  };
}
const notes: ChatMemoryList = {
  status: "idle",
  revision: "original",
  memories: [
    { id: "memory-a", text: "Retained conversation context", createdAt: 1, origin: "user_stated" },
  ],
  documents: [],
};

it("retains the same brain's last loaded chat context when its worker returns an error", () => {
  const previous = { ...reply("brain-a"), chatMemories: notes };
  const failure = reply("brain-a", "The Brain worker disconnected");
  const retained = retainChatContextOnError(previous, failure);
  expect(retained.chatMemories).toBe(notes);
  expect(retained.error).toBe(failure.error);
  expect(retained.state).toBe(failure.state);
  expect(failure.chatMemories).toBeUndefined();
});

it("clears old context if a project is disconnected from its brain or rebound elsewhere", () => {
  const previous = { ...reply("brain-a"), chatMemories: notes };
  for (const id of ["brain-b", null]) {
    const failure = reply(id, "Could not open the selected brain");
    expect(retainChatContextOnError(previous, failure).chatMemories).toBeUndefined();
  }
});

it("accepts the fresh response on recovery, including an intentionally empty result", () => {
  const previous = { ...reply("brain-a"), chatMemories: notes };
  const empty = {
    ...reply("brain-a"),
    chatMemories: { status: "idle", memories: [], revision: "new" } as const,
  };
  expect(retainChatContextOnError(previous, empty)).toBe(empty);
  const extractionError = {
    ...reply("brain-a", "Extraction failed"),
    chatMemories: { ...notes, status: "error" as const },
  };
  expect(retainChatContextOnError(previous, extractionError)).toBe(extractionError);
  expect(
    retainChatContextOnError(null, reply("brain-a", "Not loaded")).chatMemories,
  ).toBeUndefined();
});

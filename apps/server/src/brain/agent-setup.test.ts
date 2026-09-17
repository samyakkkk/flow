import { expect, it } from "vite-plus/test";
import { bindProjectWithAgentTools, manageAgentIntegration } from "./agent-setup.ts";
import type { BrainAgentIntegration } from "@t3tools/contracts";
const status: BrainAgentIntegration = {
  configured: false,
  harnesses: ["claude", "codex"],
  detected: ["claude", "codex"],
  brainName: null,
  workspaceId: null,
  pendingCaptures: 0,
  message: "",
};
it("binds every checkout of a project to its chosen Brain after recording the choice", async () => {
  const events: string[] = [];
  const manage: typeof manageAgentIntegration = async (input) => {
    events.push(`${input.operation}:${input.folder}`);
    expect(input.operation).toBe("configure");
    expect(input.workspaceId).toBe("brain");
    expect(input.harnesses).toBeUndefined();
    return status;
  };
  await bindProjectWithAgentTools(
    {
      folders: ["/one", "/two", "/one"],
      workspaceId: "brain",
      stateDir: "/state",
      bind: async () => {
        events.push("bind");
      },
    },
    manage,
  );
  expect(events).toEqual(["bind", "configure:/one", "configure:/two"]);
});
it("unbinds folders when the project's Brain is removed", async () => {
  const events: string[] = [];
  await bindProjectWithAgentTools(
    {
      folders: ["/one"],
      workspaceId: null,
      stateDir: "/state",
      bind: async () => {
        events.push("bind");
      },
    },
    async (input) => {
      events.push(input.operation);
      return { ...status, configured: true, workspaceId: "old" };
    },
  );
  expect(events).toEqual(["bind", "remove"]);
});

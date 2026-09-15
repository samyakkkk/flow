import { expect, it } from "vite-plus/test";
import { bindProjectWithAgentTools, manageAgentIntegration } from "./agent-setup.ts";
import type { BrainAgentIntegration } from "@t3tools/contracts";
const status: BrainAgentIntegration = {
  configured: false,
  harnesses: [],
  detected: ["claude", "codex"],
  brainName: null,
  workspaceId: null,
  pendingCaptures: 0,
  message: "",
};
it("automatically connects detected tools after binding a new project", async () => {
  const events: string[] = [];
  const manage: typeof manageAgentIntegration = async (input) => {
    events.push(input.operation);
    if (input.operation === "configure") {
      expect(input.harnesses).toEqual(["claude", "codex"]);
      expect(input.workspaceId).toBe("brain");
    }
    return status;
  };
  await bindProjectWithAgentTools(
    {
      folders: ["/project"],
      workspaceId: "brain",
      stateDir: "/state",
      bind: async () => {
        events.push("bind");
      },
    },
    manage,
  );
  expect(events).toEqual(["status", "bind", "configure"]);
});
it("revokes every checkout before switching and preserves its selected tools", async () => {
  const events: string[] = [];
  const manage: typeof manageAgentIntegration = async (input) => {
    events.push(input.operation);
    if (input.operation === "configure") expect(input.harnesses).toEqual(["codex"]);
    return { ...status, configured: true, workspaceId: "old", harnesses: ["codex"] };
  };
  await bindProjectWithAgentTools(
    {
      folders: ["/one", "/two"],
      workspaceId: "new",
      stateDir: "/state",
      bind: async () => {
        events.push("bind");
      },
    },
    manage,
  );
  expect(events).toEqual([
    "status",
    "status",
    "remove",
    "remove",
    "bind",
    "configure",
    "configure",
  ]);
});
it("disconnects tools without reinstalling when the Brain is removed", async () => {
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
      return { ...status, configured: true, workspaceId: "old", harnesses: ["codex"] };
    },
  );
  expect(events).toEqual(["status", "remove", "bind"]);
});

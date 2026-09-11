import { EnvironmentId, type BrainState } from "@t3tools/contracts";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("../../state/brain", () => ({ brainCommand: "brainCommand" }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.execute }));
vi.mock("./BrainIcon", () => ({ BrainIcon: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectTrigger: "button",
  SelectValue: "span",
  SelectPopup: "div",
  SelectItem: "div",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogPopup: "div",
  DialogHeader: "div",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "div",
  DialogFooter: "div",
}));

import { useProjectBrainChoice } from "./useProjectBrainChoice";

const environmentId = EnvironmentId.make("local");
let renderer: ReactTestRenderer | undefined;

function brainState(workspaces: BrainState["workspaces"]): BrainState {
  return {
    database: { status: "ready", message: "" },
    embeddings: { status: "ready", message: "" },
    github: { connected: false, login: "", message: "" },
    clis: [
      { id: "claude", installed: true },
      { id: "codex", installed: false },
      { id: "opencode", installed: false },
    ],
    workspaces,
  };
}

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

function findButton(label: string) {
  const found = renderer!.root.findAllByType("button").find((node) => text(node) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function Harness() {
  const { chooseBrain, brainChoiceDialog } = useProjectBrainChoice({ required: true });
  const [choice, setChoice] = React.useState<string | null>(null);
  return (
    <>
      <button
        onClick={() => {
          void chooseBrain(environmentId, "Acme project").then((next) =>
            setChoice(next?.workspaceId ?? null),
          );
        }}
      >
        Start
      </button>
      <output>{choice ?? "pending"}</output>
      {brainChoiceDialog}
    </>
  );
}

async function start() {
  await act(async () => findButton("Start").props.onClick());
  await act(async () => {});
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.execute.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("requires an existing brain and defaults to the first available one", async () => {
  state.execute.mockResolvedValue({
    _tag: "Success",
    value: {
      state: brainState([
        {
          id: "brain-1",
          name: "Team brain",
          cli: "claude",
          sources: [],
          knowledge: { entities: [], edges: [], memories: [] },
        },
      ]),
      error: null,
      createdWorkspaceId: null,
    },
  });
  await act(async () => {
    renderer = create(<Harness />);
  });

  await start();

  expect(text(renderer!.root)).not.toContain("Continue without a brain");
  expect(text(renderer!.root)).not.toContain("No brain");
  await act(async () => findButton("Connect brain").props.onClick());
  expect(text(renderer!.root)).toContain("brain-1");
});

it("opens a one-action creation flow and connects the new brain", async () => {
  state.execute
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { state: brainState([]), error: null, createdWorkspaceId: null },
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        state: brainState([]),
        error: null,
        createdWorkspaceId: "brain-created",
      },
    });
  await act(async () => {
    renderer = create(<Harness />);
  });

  await start();

  expect(text(renderer!.root)).toContain("Create a brain");
  expect(
    renderer!.root.findAllByType("input").find((node) => node.props.value !== undefined)?.props
      .value,
  ).toBe("My brain");
  const form = renderer!.root.findByType("form");
  await act(async () => {
    form.props.onSubmit({ preventDefault: vi.fn() });
  });
  await act(async () => {});

  expect(state.execute).toHaveBeenLastCalledWith({
    environmentId,
    input: { action: "create", name: "My brain", cli: "claude" },
  });
  expect(text(renderer!.root)).toContain("brain-created");
});

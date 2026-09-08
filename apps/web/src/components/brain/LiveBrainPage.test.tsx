import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { BrainResponse, BrainState } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  isReady: false,
  hasEnvironment: true,
  prepared: false,
  phase: "connecting" as EnvironmentConnectionPhase,
  execute: vi.fn(),
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironments: () => ({
    isReady: runtime.isReady,
    environments: runtime.hasEnvironment
      ? [
          {
            environmentId: "local",
            label: "My computer",
            connection: { phase: runtime.phase, error: null },
          },
        ]
      : [],
  }),
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () => (runtime.prepared ? Option.some({}) : Option.none()),
}));
vi.mock("../../state/brain", () => ({ brainCommand: Symbol("brain") }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => runtime.execute }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: () => null,
  DialogPopup: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
  DialogDescription: () => null,
  DialogPanel: () => null,
}));
vi.mock("./BrainControls", () => ({
  BrainSelect: () => null,
  CreateBrainDialog: () => null,
  cliName: (id: string) => id,
}));
vi.mock("./BrainSources", () => ({ BrainSources: () => null, BrainIndexing: () => null }));
vi.mock("./BrainGraph", () => ({ BrainGraph: () => <div>Knowledge graph content</div> }));

import { LiveBrainPage } from "./LiveBrainPage";

const emptyState: BrainState = {
  database: { status: "ready", message: "" },
  embeddings: { status: "ready", message: "" },
  github: { connected: false, login: "", message: "" },
  clis: [],
  workspaces: [],
};
const onSelectionChange = vi.fn();
let renderer: ReactTestRenderer | undefined;
let finishRead: (result: AsyncResult.AsyncResult<BrainResponse, Error>) => void;

async function render(environment = "local", workspace: string | null = null) {
  await act(() => {
    const page = (
      <LiveBrainPage
        selectedWorkspaceId={workspace}
        selectedEnvironmentId={environment}
        onSelectionChange={onSelectionChange}
      />
    );
    if (renderer) renderer.update(page);
    else renderer = create(page);
  });
}

function content() {
  return JSON.stringify(renderer?.toJSON());
}

beforeEach(() => {
  runtime.isReady = false;
  runtime.hasEnvironment = true;
  runtime.prepared = false;
  runtime.phase = "connecting";
  runtime.execute.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  onSelectionChange.mockClear();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setInterval, clearInterval });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Brain startup", () => {
  it("waits for the catalog and prepared connection, then shows creation only after a successful empty read", async () => {
    await render();
    expect(content()).toContain("Opening brain…");
    expect(content()).not.toContain("Create your first brain");
    expect(runtime.execute).not.toHaveBeenCalled();

    runtime.isReady = true;
    runtime.phase = "connected";
    await render();
    expect(content()).toContain("Connecting to your brain…");
    expect(runtime.execute).not.toHaveBeenCalled();

    runtime.prepared = true;
    await render();
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(content()).toContain("Loading your brains and their knowledge.");
    expect(content()).not.toContain("Create your first brain");

    await act(() =>
      finishRead(AsyncResult.success({ state: emptyState, error: null, createdWorkspaceId: null })),
    );
    expect(content()).toContain("Create your first brain");
  });

  it.each(["offline", "error", "reconnecting"] as const)(
    "does not treat %s as an empty brain list",
    async (phase) => {
      runtime.isReady = true;
      runtime.phase = phase;
      runtime.prepared = true;
      await render();
      expect(content()).not.toContain("Create your first brain");
      expect(content()).not.toContain("Choose a name and the CLI");
      expect(runtime.execute).not.toHaveBeenCalled();
    },
  );

  it("keeps a missing selected remote host from falling back to the local brain", async () => {
    runtime.isReady = true;
    runtime.phase = "connected";
    runtime.prepared = true;
    await render("missing-remote");
    expect(content()).toContain("Choose a brain computer");
    expect(content()).not.toContain("Create your first brain");
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("shows a read failure without offering creation, then recovers on the next read", async () => {
    runtime.isReady = true;
    runtime.phase = "connected";
    runtime.prepared = true;
    await render();
    await act(() =>
      finishRead(AsyncResult.failure(Cause.fail(new Error("Brain service unavailable")))),
    );
    expect(content()).toContain("Brain service unavailable");
    expect(content()).toContain("Brain unavailable");
    expect(content()).not.toContain("Create your first brain");
    await act(() => vi.advanceTimersByTime(2000));
    await act(() =>
      finishRead(AsyncResult.success({ state: emptyState, error: null, createdWorkspaceId: null })),
    );
    expect(content()).not.toContain("Brain service unavailable");
    expect(content()).toContain("Create your first brain");
  });

  it("retains loaded knowledge while reconnecting and refreshes immediately on reconnection", async () => {
    runtime.isReady = true;
    runtime.phase = "connected";
    runtime.prepared = true;
    await render("local", "brain");
    await act(() =>
      finishRead(
        AsyncResult.success({
          error: null,
          createdWorkspaceId: null,
          state: {
            ...emptyState,
            workspaces: [
              {
                id: "brain",
                name: "My brain",
                cli: "codex",
                sources: [],
                knowledge: {
                  entities: [
                    { id: "node", name: "Node", kind: "Service", description: "", source: "" },
                  ],
                  edges: [],
                  memories: [],
                },
              },
            ],
          },
        }),
      ),
    );
    runtime.phase = "reconnecting";
    runtime.prepared = false;
    await render("local", "brain");
    expect(content()).toContain("Reconnecting to your brain…");
    expect(content()).toContain("Knowledge graph content");
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    runtime.phase = "connected";
    runtime.prepared = true;
    await render("local", "brain");
    expect(runtime.execute).toHaveBeenCalledTimes(2);
    expect(content()).not.toContain("Reconnecting to your brain…");
  });
});

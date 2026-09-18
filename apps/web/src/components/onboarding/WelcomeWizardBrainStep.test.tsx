import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { BrainCommand, BrainResponse } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  providers: [] as unknown[],
  config: null as unknown,
  execute: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { kind: string }) =>
    atom.kind === "providers" ? runtime.providers : runtime.config,
}));
// Stable per-atom executors: the step's read effect depends on the command
// identity, so a fresh function per render would re-read forever.
vi.mock("../../state/use-atom-command", () => {
  const executors = new Map<string, (args: unknown) => unknown>();
  return {
    useAtomCommand: (atom: string) => {
      const existing = executors.get(atom);
      if (existing) return existing;
      const next = (args: unknown) => runtime.execute(atom, args);
      executors.set(atom, next);
      return next;
    },
  };
});
vi.mock("../../state/brain", () => ({ brainCommand: "brainCommand" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => ({ kind: "providers" }),
    configValueAtom: () => ({ kind: "config" }),
    refreshProviders: "refreshProviders",
    updateSettings: "updateSettings",
  },
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("./ProjectSourcePicker", () => ({ ProjectSourcePicker: () => null }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../BrandWordmark", () => ({ BrandWordmark: () => null }));

import { ConnectedAgentsStep } from "./WelcomeWizard";

const environmentId = "local" as never;
const onChoose = vi.fn();
const onContinue = vi.fn();
let renderer: ReactTestRenderer | undefined;

const readyProvider = (driver: string) => ({
  driver,
  instanceId: driver,
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
});

function brainResponse(overrides: Partial<BrainResponse>): BrainResponse {
  return {
    state: {
      database: { status: "ready", message: "" },
      embeddings: { status: "ready", message: "" },
      github: { connected: false, login: "", message: "" },
      clis: [
        { id: "claude", installed: true },
        { id: "codex", installed: false },
        { id: "opencode", installed: false },
      ],
      workspaces: [],
    },
    error: null,
    createdWorkspaceId: null,
    ...overrides,
  } as BrainResponse;
}

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

function labelled(label: string): ReactTestInstance | undefined {
  return renderer!.root
    .findAllByType("label")
    .find((node) => text(node).startsWith(label))
    ?.findAllByType("input")[0];
}

function primaryButton(): ReactTestInstance {
  const buttons = renderer!.root.findAllByType("button");
  const found = buttons.findLast(
    (node) => typeof node.props.onClick === "function" && text(node).trim() !== "",
  );
  if (!found) throw new Error("Missing primary button");
  return found;
}

function modeButton(label: string): ReactTestInstance {
  const found = renderer!.root
    .findAllByType("button")
    .find((node) => node.props.role === "radio" && text(node) === label);
  if (!found) throw new Error(`Missing mode: ${label}`);
  return found;
}

async function type(label: string, value: string) {
  const input = labelled(label);
  if (!input) throw new Error(`Missing field: ${label}`);
  await act(async () => input.props.onChange({ target: { value } }));
}

async function render() {
  await act(async () => {
    renderer = create(
      <ConnectedAgentsStep
        environmentId={environmentId}
        choice={undefined}
        onChoose={onChoose}
        onContinue={onContinue}
      />,
    );
  });
  await act(async () => {});
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  runtime.providers = [readyProvider("claudeAgent")];
  runtime.config = null;
  onChoose.mockReset();
  onContinue.mockReset();
  runtime.execute.mockReset().mockImplementation(async (atom: string) => {
    if (atom !== "brainCommand") return { _tag: "Success", value: {} };
    return { _tag: "Success", value: brainResponse({}) };
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function brainCalls(): BrainCommand[] {
  return runtime.execute.mock.calls
    .filter(([atom]) => atom === "brainCommand")
    .map(([, args]) => (args as { input: BrainCommand }).input);
}

describe("onboarding Brain step", () => {
  it("creates a local Brain by default and advances", async () => {
    await render();
    expect(labelled("Brain name")).toBeDefined();
    expect(labelled("Brain URL or invitation link")).toBeUndefined();
    expect(text(primaryButton())).toContain("Create Brain");

    runtime.execute.mockImplementation(async () => ({
      _tag: "Success",
      value: brainResponse({ createdWorkspaceId: "brain-1" }),
    }));
    await act(async () => primaryButton().props.onClick());
    expect(brainCalls().at(-1)).toEqual({ action: "create", name: "My Brain", cli: "claude" });
    expect(onChoose).toHaveBeenCalledWith(environmentId, { id: "brain-1", name: "My Brain" });
    expect(onContinue).toHaveBeenCalledWith(environmentId);
  });

  it("offers only a team Brain on a computer that cannot host one", async () => {
    // Windows has no native graph database, so there is no local Brain to
    // create and no choice to make: the step is the connect form.
    runtime.execute.mockImplementation(async (atom: string) => {
      if (atom !== "brainCommand") return { _tag: "Success", value: {} };
      const response = brainResponse({});
      return {
        _tag: "Success",
        value: { ...response, state: { ...response.state, localBrains: false } },
      };
    });
    await render();

    expect(
      renderer!.root.findAllByType("button").filter((node) => node.props.role === "radio"),
    ).toEqual([]);
    expect(labelled("Brain name")).toBeUndefined();
    expect(labelled("Brain URL or invitation link")).toBeDefined();
    expect(text(primaryButton())).toContain("Connect Brain");
  });

  it("swaps the create fields for connect fields and requires all three", async () => {
    await render();
    await act(async () => modeButton("Connect to your team Brain").props.onClick());

    expect(labelled("Brain name")).toBeUndefined();
    // Conversation notes are curated locally, so the CLI choice stays in connect mode.
    expect(
      renderer!.root.findAllByProps({ type: "radio", name: "brain-cli-local" }).length,
    ).toBeGreaterThan(0);
    expect(labelled("Brain URL or invitation link")).toBeDefined();
    expect(labelled("Email")).toBeDefined();
    expect(labelled("Password")).toBeDefined();
    expect(text(primaryButton())).toContain("Connect Brain");
    expect(primaryButton().props.disabled).toBe(true);

    await type("Brain URL or invitation link", "https://brain.example.com");
    await type("Email", "dev@example.com");
    expect(primaryButton().props.disabled).toBe(true);
    await type("Password", "hunter2hunter2");
    expect(primaryButton().props.disabled).toBe(false);
  });

  it("connects an existing remote Brain, records it, and advances", async () => {
    await render();
    await act(async () => modeButton("Connect to your team Brain").props.onClick());
    await type("Brain URL or invitation link", "  https://brain.example.com  ");
    await type("Email", "  dev@example.com ");
    await type("Password", " hunter2hunter2 ");

    runtime.execute.mockImplementation(async () => ({
      _tag: "Success",
      value: brainResponse({
        createdWorkspaceId: "remote-1",
        state: {
          ...brainResponse({}).state,
          workspaces: [
            {
              id: "remote-1",
              name: "Acme Brain",
              remote: { endpoint: "https://brain.example.com", brainId: "b1", status: "ready" },
              sources: [
                { id: "s1", repository: "https://github.com/team/app" },
                { id: "s2", repository: "https://github.com/team/site" },
              ],
            },
          ] as never,
        },
      }),
    }));
    await act(async () => primaryButton().props.onClick());

    expect(brainCalls().at(-1)).toEqual({
      action: "connectCloud",
      endpoint: "https://brain.example.com",
      email: "dev@example.com",
      password: " hunter2hunter2 ",
      cli: "claude",
    });
    expect(onChoose).toHaveBeenCalledWith(environmentId, {
      id: "remote-1",
      name: "Acme Brain",
      sources: ["https://github.com/team/app", "https://github.com/team/site"],
    });
    expect(onContinue).toHaveBeenCalledWith(environmentId);
    expect(labelled("Password")!.props.value).toBe("");
  });

  it("shows the server error and stays on the step when the connect fails", async () => {
    await render();
    await act(async () => modeButton("Connect to your team Brain").props.onClick());
    await type("Brain URL or invitation link", "https://brain.example.com");
    await type("Email", "dev@example.com");
    await type("Password", "wrong-password");

    runtime.execute.mockImplementation(async () => ({
      _tag: "Success",
      value: brainResponse({ error: "Invalid email or password." }),
    }));
    await act(async () => primaryButton().props.onClick());

    expect(JSON.stringify(renderer!.toJSON())).toContain("Invalid email or password.");
    expect(onChoose).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("falls back to guidance copy when the connect fails without a message", async () => {
    await render();
    await act(async () => modeButton("Connect to your team Brain").props.onClick());
    await type("Brain URL or invitation link", "https://brain.example.com");
    await type("Email", "dev@example.com");
    await type("Password", "hunter2hunter2");

    runtime.execute.mockImplementation(async () => ({ _tag: "Failure", cause: "boom" }));
    await act(async () => primaryButton().props.onClick());

    expect(JSON.stringify(renderer!.toJSON())).toContain("Could not connect to this Brain.");
    expect(onContinue).not.toHaveBeenCalled();
  });
});

import type { BrainRepository, BrainSnapshot } from "./repository";

const flow: BrainSnapshot = {
  id: "sample-flow",
  name: "Flow",
  description: "The context behind your code. Connected, remembered, ready for your next session.",
  entities: [
    {
      id: "brain",
      name: "Brain",
      kind: "System",
      description:
        "One brain per workspace. Its location can change without changing where agents execute.",
      x: 50,
      y: 48,
    },
    {
      id: "app",
      name: "Desktop app",
      kind: "Surface",
      description:
        "The shared web interface inside the desktop shell. Projects begin here, without a CLI setup step.",
      x: 22,
      y: 22,
    },
    {
      id: "graph",
      name: "Knowledge graph",
      kind: "Storage",
      description: "A workspace-scoped graph in the shared local FalkorDB instance.",
      x: 79,
      y: 24,
    },
    {
      id: "memory",
      name: "Memory",
      kind: "Capability",
      description: "Decisions, preferences and lessons grounded in their original source.",
      x: 78,
      y: 73,
    },
    {
      id: "embedding",
      name: "Embeddings",
      kind: "Service",
      description: "One loaded model serves all local workspaces through the brain backend.",
      x: 26,
      y: 77,
    },
    {
      id: "agents",
      name: "Agent sessions",
      kind: "Source",
      description: "Coding sessions provide observations; the brain distills durable context.",
      x: 17,
      y: 49,
    },
  ],
  edges: [
    { from: "app", to: "brain", label: "connects to" },
    { from: "brain", to: "graph", label: "indexes" },
    { from: "brain", to: "memory", label: "remembers" },
    { from: "brain", to: "embedding", label: "embeds with" },
    { from: "agents", to: "brain", label: "contributes to" },
  ],
  memories: [
    {
      id: "m1",
      kind: "Decision",
      title: "One brain. Wherever your workspace lives.",
      body: "A workspace starts locally. Moving it to cloud transfers its data and changes the brain connection; it does not create a second brain.",
      source: "Sample session · Workspace architecture",
      entityIds: ["brain", "app"],
    },
    {
      id: "m2",
      kind: "Decision",
      title: "Share the database, isolate the graphs",
      body: "All local projects use one FalkorDB instance. Each workspace has its own graph scope so knowledge stays within that workspace.",
      source: "Sample session · Local runtime",
      entityIds: ["graph", "brain"],
    },
    {
      id: "m3",
      kind: "Preference",
      title: "Start in the app, not the terminal",
      body: "Creating a project in the UI should be enough. The app manages the local brain services automatically.",
      source: "Sample session · Developer experience",
      entityIds: ["app"],
    },
    {
      id: "m4",
      kind: "Gotcha",
      title: "Do not load a model for every project",
      body: "Loading an embedding model per workspace wastes memory. Keep one shared embedding service and route requests through it.",
      source: "Sample note · Resource ownership",
      entityIds: ["embedding"],
    },
    {
      id: "m5",
      kind: "Decision",
      title: "Execution and knowledge have separate homes",
      body: "An agent can work in a local checkout while its workspace brain lives remotely. An offline remote brain must not silently become local.",
      source: "Sample session · Remote connections",
      entityIds: ["agents", "brain"],
    },
    {
      id: "m6",
      kind: "Preference",
      title: "Keep the evidence with the memory",
      body: "Every durable conclusion should lead back to a source, so the next agent can understand why the decision was made.",
      source: "Sample note · Memory quality",
      entityIds: ["memory"],
    },
  ],
  sources: [
    { name: "flow", detail: "Repository · sample architecture" },
    { name: "Agent sessions", detail: "4 example conversations" },
    { name: "Workspace notes", detail: "2 example notes" },
  ],
};
const checkout: BrainSnapshot = {
  id: "sample-checkout",
  name: "Checkout",
  description: "A second sample workspace with its own knowledge and decisions.",
  entities: [
    {
      id: "checkout",
      name: "Checkout API",
      kind: "Service",
      description: "Coordinates orders and payment requests.",
      x: 50,
      y: 48,
    },
    {
      id: "payments",
      name: "Payments",
      kind: "Service",
      description: "Processes idempotent payment requests.",
      x: 23,
      y: 24,
    },
    {
      id: "orders",
      name: "Orders",
      kind: "Storage",
      description: "Stores order state independently of payment callbacks.",
      x: 77,
      y: 70,
    },
  ],
  edges: [
    { from: "checkout", to: "payments", label: "charges through" },
    { from: "checkout", to: "orders", label: "creates" },
  ],
  memories: [
    {
      id: "c1",
      kind: "Gotcha",
      title: "Payment callbacks can arrive twice",
      body: "Deduplicate callbacks by event ID before changing order state. Retrying delivery must not create a second order.",
      source: "Sample session · Payment retries",
      entityIds: ["payments", "orders"],
    },
    {
      id: "c2",
      kind: "Decision",
      title: "Keep checkout responsive",
      body: "Send the order receipt asynchronously after the payment succeeds.",
      source: "Sample note · Checkout design",
      entityIds: ["checkout"],
    },
  ],
  sources: [
    { name: "checkout-api", detail: "Repository · sample service" },
    { name: "Agent sessions", detail: "1 example conversation" },
  ],
};
const workspaces = [flow, checkout];
export const sampleBrainRepository: BrainRepository = {
  mode: "sample",
  listWorkspaces: () => workspaces.map(({ id, name }) => ({ id, name })),
  read(id) {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error(`Unknown sample workspace: ${id}`);
    return workspace;
  },
};

import type { BrainResponse } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CONNECT_CLOUD_ERROR,
  connectCloudCommand,
  connectCloudOutcome,
  connectCloudReady,
} from "./connectCloud";

const response = (overrides: Partial<BrainResponse>) =>
  ({ error: null, createdWorkspaceId: null, ...overrides }) as BrainResponse;

describe("connectCloudReady", () => {
  it("requires an endpoint, an email and a password", () => {
    expect(connectCloudReady({ endpoint: "  ", email: "a@b.c", password: "pw" })).toBe(false);
    expect(connectCloudReady({ endpoint: "https://x", email: " ", password: "pw" })).toBe(false);
    expect(connectCloudReady({ endpoint: "https://x", email: "a@b.c", password: "" })).toBe(false);
    expect(connectCloudReady({ endpoint: " https://x ", email: " a@b.c ", password: " " })).toBe(
      true,
    );
  });
});

describe("connectCloudCommand", () => {
  it("trims the endpoint and email but never the password", () => {
    expect(
      connectCloudCommand({ endpoint: " https://x ", email: " a@b.c ", password: " pw " }),
    ).toEqual({ action: "connectCloud", endpoint: "https://x", email: "a@b.c", password: " pw " });
  });

  it("includes a workspace id only when reconnecting an existing Brain", () => {
    expect(
      connectCloudCommand({ endpoint: "https://x", email: "a@b.c", password: "pw" }, "ws-1"),
    ).toMatchObject({ workspaceId: "ws-1" });
    expect(
      connectCloudCommand({ endpoint: "https://x", email: "a@b.c", password: "pw" }),
    ).not.toHaveProperty("workspaceId");
  });
});

describe("connectCloudOutcome", () => {
  it("reports the created workspace on success", () => {
    expect(connectCloudOutcome(response({ createdWorkspaceId: "ws-9" }))).toEqual({
      ok: true,
      workspaceId: "ws-9",
    });
  });

  it("prefers the server message and falls back for transport failures", () => {
    expect(connectCloudOutcome(response({ error: "Invalid password." }))).toEqual({
      ok: false,
      error: "Invalid password.",
    });
    expect(connectCloudOutcome(null)).toEqual({ ok: false, error: CONNECT_CLOUD_ERROR });
    expect(connectCloudOutcome(response({}), "custom")).toEqual({ ok: false, error: "custom" });
  });
});

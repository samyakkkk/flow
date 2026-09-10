import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { fetchFlowBrowserUpdate, waitForFlowBrowserUpdate } from "./flowBrowserUpdate";

const state = {
  supported: true,
  currentVersion: "1.0.0",
  readyVersion: "1.1.0",
  restarting: false,
};
afterEach(() => vi.unstubAllGlobals());

describe("Flow browser updates", () => {
  it("uses an authenticated same-origin JSON POST for an explicit restart", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ...state, restarting: true })));
    vi.stubGlobal("fetch", fetch);
    expect((await fetchFlowBrowserUpdate(true)).restarting).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "/api/flow/browser-update",
      expect.objectContaining({ method: "POST", credentials: "same-origin", body: "{}" }),
    );
  });
  it("does not accept an HTTP error or malformed response as an update acknowledgement", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
    await expect(fetchFlowBrowserUpdate(true)).rejects.toThrow("403");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await expect(fetchFlowBrowserUpdate()).rejects.toThrow();
  });
  it("waits through connection loss and the old server until the target version is ready", async () => {
    let now = 0;
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({ ...state, currentVersion: "1.1.0", readyVersion: null });
    await waitForFlowBrowserUpdate("1.1.0", {
      read,
      wait: async () => {
        now += 1000;
      },
      now: () => now,
    });
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("reports failure instead of treating a reconnect to the old version as success", async () => {
    let now = 0;
    await expect(
      waitForFlowBrowserUpdate("1.1.0", {
        read: async () => state,
        wait: async () => {
          now += 60000;
        },
        now: () => now,
      }),
    ).rejects.toThrow("not reconnected");
  });
});

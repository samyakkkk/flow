// @effect-diagnostics globalFetch:off - Tests the standalone HTTP transport boundary.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { CloudClient, cloudEndpoint } from "./cloud-client.ts";
import { GithubConnection } from "../../../../flow-t3/shared/runtime/src/github.ts";
afterEach(() => vi.unstubAllGlobals());
describe("cloud transport", () => {
  it("requires HTTPS and rejects credentials in URLs", () => {
    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com?token=secret",
      "https://example.com#secret",
    ])
      expect(() => cloudEndpoint(url)).toThrow();
    expect(cloudEndpoint("https://example.com/")).toBe("https://example.com");
    expect(cloudEndpoint("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });
  it("scopes requests and sends credentials only as an authorization header", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: null })));
    vi.stubGlobal("fetch", fetcher);
    await new CloudClient(
      "https://brain.example",
      "test-secret",
      "desktop-one",
      "brain-one",
    ).capture({
      receipt: "r1",
      kind: "user_prompt",
      context: { session: "chat-one" },
      data: "hello",
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://brain.example/v1/brain");
    expect(init.redirect).toBe("error");
    expect(init.headers.authorization).toBe("Bearer test-secret");
    expect(JSON.parse(init.body)).toMatchObject({
      version: 1,
      instance: "desktop-one",
      brainId: "brain-one",
      capture: { receipt: "r1", context: { session: "chat-one" } },
    });
    expect(init.body).not.toContain("test-secret");
  });
  it("fails explicitly on remote auth and transport errors", async () => {
    const client = new CloudClient("https://brain.example", "test-secret", "one");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(client.state()).rejects.toThrow("authentication failed");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("upstream offline", { status: 502 })),
    );
    await expect(client.state()).rejects.toThrow("Cloud Brain is unavailable (HTTP 502)");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(client.state()).rejects.toThrow("offline");
  });
});
describe("deployment GitHub credentials", () => {
  it("signs and caches read-only installation tokens", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetcher = vi
      .fn()
      .mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("/access_tokens")
                ? { token: "installation-fixture", expires_at: "2099-01-01T00:00:00Z" }
                : { repositories: [] },
            ),
          ),
      );
    vi.stubGlobal("fetch", fetcher);
    const github = new GithubConnection({
      kind: "app",
      appId: "123",
      installationId: "456",
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    await github.status();
    await github.status();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access_tokens"))).toHaveLength(1);
    const init = fetcher.mock.calls[0]![1];
    expect(JSON.parse(init.body)).toEqual({ permissions: { contents: "read" } });
    const jwt = init.headers.authorization.slice(7).split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(jwt.slice(0, 2).join("."));
    expect(verifier.verify(keys.publicKey, Buffer.from(jwt[2], "base64url"))).toBe(true);
  });

  it("disables ambient git helpers and scopes auth to GitHub", async () => {
    const env = await new GithubConnection({
      kind: "token",
      token: "synthetic-example",
    }).gitEnvironment();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_KEY_1).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
  it("rejects invalid repository paths before sending credentials", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new GithubConnection({ kind: "token", token: "synthetic-example" }).branches("../evil"),
    ).rejects.toThrow("Invalid GitHub");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not expose GitHub response bodies in errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private response", { status: 403 })),
    );
    await expect(
      new GithubConnection({ kind: "token", token: "synthetic-example" }).status(),
    ).rejects.toThrow("HTTP 403");
  });
});

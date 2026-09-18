// @effect-diagnostics globalFetch:off - Tests the standalone HTTP transport boundary.
// @effect-diagnostics nodeBuiltinImport:off - Temporary directory for the native tool catalog cache.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CloudClient, cloudEndpoint, cloudSignInTarget, signInToCloud } from "./cloud-client.ts";
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
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: [] })));
    vi.stubGlobal("fetch", fetcher);
    await new CloudClient("https://brain.example", "test-secret", "desktop-one", "brain-one").sync(
      [],
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://brain.example/v1/brain");
    expect(init.redirect).toBe("error");
    expect(init.headers.authorization).toBe("Bearer test-secret");
    expect(JSON.parse(init.body)).toMatchObject({
      version: 1,
      instance: "desktop-one",
      brainId: "brain-one",
      method: "sync",
      items: [],
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
  it("serves the cloud's tool catalog from cache, including while the cloud is offline", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-cloud-tools-"));
    const catalog = [{ name: "cloud_only", inputSchema: { type: "object" } }];
    const fetcher = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ result: catalog })));
    vi.stubGlobal("fetch", fetcher);
    const client = new CloudClient("https://brain.example", "secret", "one", "brain", directory);
    expect((await client.tools()).map((tool) => tool.name)).toEqual(["cloud_only"]);
    await client.tools();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).method).toBe("tools");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const restarted = new CloudClient("https://brain.example", "secret", "one", "brain", directory);
    expect((await restarted.tools()).map((tool) => tool.name)).toEqual(["cloud_only"]);
    const uncached = new CloudClient("https://brain.example", "secret", "one", "brain");
    await expect(uncached.tools()).rejects.toThrow("offline");
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
});
describe("deployment GitHub credentials", () => {
  it("signs and caches read-only installation tokens", async () => {
    const keys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
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
    const verifier = NodeCrypto.createVerify("RSA-SHA256");
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

describe("individual Cloud sign-in", () => {
  it("exchanges an invitation and password without storing either in the endpoint", async () => {
    const invite = "a".repeat(64);
    const credential = "b".repeat(64);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: credential,
          user: { id: "person", email: "person@example.com" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await signInToCloud(
        `https://brain.example/invite#${invite}`,
        "person@example.com",
        "test-password",
      ),
    ).toEqual({
      endpoint: "https://brain.example",
      token: credential,
      account: { id: "person", email: "person@example.com" },
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://brain.example/auth/connect");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({
      email: "person@example.com",
      password: "test-password",
      invitation: invite,
    });
    expect(() => cloudSignInTarget("https://brain.example/reset#" + invite)).toThrow();
    expect(() => cloudSignInTarget("https://brain.example/invite?token=" + invite)).toThrow();
    expect(() => cloudSignInTarget("http://brain.example")).toThrow();
  });
  it("does not expose remote errors that could echo passwords", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "password-echo" }), { status: 400 }),
        ),
    );
    await expect(
      signInToCloud("https://brain.example", "person@example.com", "password-echo"),
    ).rejects.toThrow("Cloud sign-in failed");
  });
});

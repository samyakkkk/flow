// @effect-diagnostics globalFetch:off globalDate:off - Standalone Node credential adapter with expiring GitHub tokens.
import { createSign } from "node:crypto";

export type GithubCredential =
  | { kind: "public" }
  | { kind: "token"; token: string }
  | { kind: "app"; appId: string; installationId: string; privateKey: string };
export interface GithubAccess {
  status(): Promise<{ connected: boolean; login: string; message: string }>;
  repositories(): Promise<{ name: string; private: boolean }[]>;
  branches(repository: string): Promise<string[]>;
  gitEnvironment(): Promise<NodeJS.ProcessEnv>;
}
/** A deployment-owned credential. Never consults ambient gh login or Git helpers. */
export class GithubConnection implements GithubAccess {
  private cached: { token: string; expires: number } | undefined;
  private readonly credential: GithubCredential;
  readonly access: "read" | "write";
  constructor(credential: GithubCredential, access: "read" | "write" = "read") {
    this.credential = credential;
    this.access = access;
  }
  private async token() {
    if (this.credential.kind === "public") return "";
    if (this.credential.kind === "token") return this.credential.token;
    if (this.cached && this.cached.expires > Date.now() + 60_000) return this.cached.token;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.credential.appId })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const jwt = `${unsigned}.${signer.sign(this.credential.privateKey, "base64url")}`;
    const response = await fetch(
      `https://api.github.com/app/installations/${encodeURIComponent(this.credential.installationId)}/access_tokens`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          permissions: {
            contents: this.access,
            ...(this.access === "write" ? { pull_requests: "write" } : {}),
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `GitHub App token creation failed (HTTP ${response.status}). Check installation permissions.`,
      );
    const data = (await response.json()) as { token: string; expires_at: string };
    if (!data.token || !Number.isFinite(Date.parse(data.expires_at)))
      throw new Error("Invalid GitHub App token response.");
    this.cached = { token: data.token, expires: Date.parse(data.expires_at) };
    return data.token;
  }
  async api(path: string) {
    const token = await this.token();
    const response = await fetch(`https://api.github.com/${path}`, {
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        `GitHub request failed (HTTP ${response.status}). Check repository access and rate limits.`,
      );
    return response.json();
  }
  async status() {
    if (this.credential.kind === "public")
      return {
        connected: false,
        login: "",
        message: "Public GitHub repositories · no credential configured",
      };
    if (this.credential.kind === "app") {
      await this.api("installation/repositories?per_page=1");
      return {
        connected: true,
        login: `App installation ${this.credential.installationId}`,
        message: `GitHub App · ${this.access} access`,
      };
    }
    const user = (await this.api("user")) as { login: string };
    return {
      connected: true,
      login: user.login,
      message: `GitHub token · ${this.access} operations enabled`,
    };
  }
  async repositories() {
    if (this.credential.kind === "public") return [];
    const rows: { name: string; private: boolean }[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = (await this.api(
        `${this.credential.kind === "app" ? "installation/repositories" : "user/repos"}?per_page=100&page=${page}`,
      )) as
        | { repositories?: { full_name: string; private: boolean }[] }
        | { full_name: string; private: boolean }[];
      const items = Array.isArray(data) ? data : (data.repositories ?? []);
      rows.push(...items.map((r) => ({ name: r.full_name, private: r.private })));
      if (items.length < 100) break;
    }
    return rows;
  }
  async branches(repository: string) {
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(repository))
      throw new Error("Invalid GitHub repository.");
    const rows: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const items = (await this.api(`repos/${repository}/branches?per_page=100&page=${page}`)) as {
        name: string;
      }[];
      rows.push(...items.map((r) => r.name));
      if (items.length < 100) break;
    }
    return rows;
  }
  async gitEnvironment() {
    const token = await this.token();
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: token ? "2" : "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      ...(token
        ? {
            GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          }
        : {}),
    };
  }
}

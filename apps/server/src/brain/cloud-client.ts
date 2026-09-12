// @effect-diagnostics globalFetch:off - Explicit remote Brain transport.
import * as Schema from "effect/Schema";
import { BrainState, BrainDocument, ChatMemoryList } from "@t3tools/contracts";
import { McpSchema } from "effect/unstable/ai";
import type { BrainCommand } from "@t3tools/contracts";
import type { BrainCapture, BrainSessionContext } from "@flow/brain-runtime";

export function cloudEndpoint(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Use a cloud URL without credentials, query parameters or fragments.");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw new Error("Cloud Brain connections require HTTPS.");
  return url.toString().replace(/\/$/, "");
}
const state = Schema.decodeUnknownSync(BrainState);
const tool = Schema.decodeUnknownSync(McpSchema.CallToolResult);
const memories = Schema.decodeUnknownSync(ChatMemoryList);
const document = Schema.decodeUnknownSync(Schema.NullOr(BrainDocument));
const reply = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.String),
  }),
);
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const repos = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ name: Schema.String, private: Schema.Boolean })),
);
export class CloudClient {
  readonly endpoint: string;
  private readonly token: string;
  readonly instance: string;
  readonly brainId: string | undefined;
  constructor(endpoint: string, token: string, instance: string, brainId?: string) {
    this.token = token;
    this.instance = instance;
    this.brainId = brainId;
    this.endpoint = cloudEndpoint(endpoint);
    if (!token.trim()) throw new Error("Enter the cloud access token.");
  }
  async request(method: string, input: Record<string, unknown> = {}) {
    const response = await fetch(`${this.endpoint}/v1/brain`, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        method,
        instance: this.instance,
        brainId: this.brainId,
        ...input,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 401)
      throw new Error("Cloud Brain authentication failed. Check its access token.");
    const payload = await response.json().catch(() => {
      throw new Error(`Cloud Brain is unavailable (HTTP ${response.status}).`);
    });
    const body = reply(payload);
    if (!response.ok || body.error) throw new Error(body.error ?? "Cloud Brain is unavailable.");
    return body.result;
  }
  async state(metadataOnly = false) {
    return state(await this.request("state", { metadataOnly }));
  }
  async call(name: string, args: Record<string, unknown>, context: BrainSessionContext) {
    return tool(await this.request("call", { name, args, context }));
  }
  async capture(capture: BrainCapture) {
    await this.request("capture", { capture });
  }
  async memories(session: string, revision?: string) {
    return memories(await this.request("memories", { context: { session }, revision }));
  }
  async document(id: string) {
    return document(await this.request("document", { name: id }));
  }
  async command(command: BrainCommand) {
    await this.request("command", { command });
  }
  async repositories() {
    return [...repos(await this.request("repositories"))];
  }
  async branches(name: string) {
    return [...strings(await this.request("branches", { name }))];
  }
}

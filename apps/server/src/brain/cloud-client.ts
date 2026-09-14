// @effect-diagnostics nodeBuiltinImport:off - Native cloud cache adapter owns its filesystem paths.
// @effect-diagnostics globalFetch:off - Explicit remote Brain transport.
import { CloudReadCache } from "../../../../flow-t3/shared/runtime/src/cloud-read-cache.ts";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { BrainState, BrainDocument, ChatMemoryList } from "@t3tools/contracts";
import { McpSchema } from "effect/unstable/ai";
import type { BrainCommand, BrainTransferRequest } from "@t3tools/contracts";
import type { BrainSessionContext } from "@flow/brain-runtime";
import type {
  BrainDocumentSync,
  BrainDocumentSyncAck,
} from "../../../../flow-t3/shared/orchestrator/src/curation/types.ts";

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
/** Invitation fragments stay in the authentication exchange, never in saved endpoints. */
export function cloudSignInTarget(value: string) {
  const url = new URL(value);
  const invitation = url.pathname === "/invite" ? url.hash.slice(1) : undefined;
  if (url.pathname !== "/" && url.pathname !== "/invite")
    throw new Error("Enter the Brain's base URL or invitation link.");
  if (url.search || url.username || url.password || (url.hash && !invitation))
    throw new Error("Enter a valid Brain URL or invitation link.");
  if (url.pathname === "/invite" && !/^[a-f0-9]{64}$/.test(invitation ?? ""))
    throw new Error("The invitation link is incomplete.");
  return { endpoint: cloudEndpoint(url.origin), invitation };
}
const decodeCredentials = Schema.decodeUnknownSync(
  Schema.Struct({
    token: Schema.String,
    user: Schema.Struct({ id: Schema.String, email: Schema.String }),
  }),
);
export async function signInToCloud(
  value: string,
  email: string,
  password: string,
  legacy?: { instance: string; legacyToken: string },
) {
  const { endpoint, invitation } = cloudSignInTarget(value);
  const response = await fetch(`${endpoint}/auth/connect`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, invitation, ...legacy }),
    signal: AbortSignal.timeout(30_000),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // Do not forward arbitrary remote response text: it could echo the password.
    if (response.status === 401) throw new Error("Email or password is incorrect.");
    if (response.status === 403)
      throw new Error("Access denied. Check the invited email or contact your administrator.");
    if (response.status === 410)
      throw new Error(
        "This invitation expired or was revoked. Ask your administrator for a new link.",
      );
    if (response.status === 429) throw new Error("Too many sign-in attempts. Retry in a minute.");
    throw new Error(
      "Cloud sign-in failed. Check the URL and use a password between 12 and 256 characters.",
    );
  }
  let credentials;
  try {
    credentials = decodeCredentials(result);
  } catch {
    throw new Error("Invalid Cloud connection credential.");
  }
  if (!/^[a-f0-9]{64}$/.test(credentials.token))
    throw new Error("Invalid Cloud connection credential.");
  return { endpoint, token: credentials.token, account: credentials.user };
}
const transferReceipt = Schema.decodeUnknownSync(
  Schema.Struct({ digest: Schema.String, documents: Schema.Number }),
);
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
const syncAcks = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ id: Schema.String, revision: Schema.Number, remoteId: Schema.String }),
  ),
);
const repos = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ name: Schema.String, private: Schema.Boolean })),
);
export class CloudClient {
  readonly endpoint: string;
  private readonly token: string;
  readonly instance: string;
  readonly brainId: string | undefined;
  readonly cache: CloudReadCache<BrainState, BrainDocument> | undefined;
  constructor(
    endpoint: string,
    token: string,
    instance: string,
    brainId?: string,
    cacheDirectory?: string,
  ) {
    this.token = token;
    this.instance = instance;
    this.brainId = brainId;
    this.endpoint = cloudEndpoint(endpoint);
    if (!token.trim()) throw new Error("Enter the cloud access token.");
    if (cacheDirectory && brainId) {
      const scope = NodeCrypto.createHash("sha256")
        .update(JSON.stringify([this.endpoint, brainId, instance, token]))
        .digest("hex");
      this.cache = new CloudReadCache({
        file: NodePath.join(cacheDirectory, `${scope}.json`),
        state: async () => {
          const result = state(await this.request("state", { metadataOnly: false }));
          if (result.database.status !== "ready") throw new Error(result.database.message);
          if (!result.workspaces.some((workspace) => workspace.id === brainId))
            throw new Error("The connected cloud Brain no longer exists.");
          return result;
        },
        document: async (id) => document(await this.request("document", { name: id })),
        summaries: (snapshot) =>
          snapshot.workspaces.find((workspace) => workspace.id === brainId)?.knowledge.documents ??
          [],
        decodeState: state,
        decodeDocument: Schema.decodeUnknownSync(BrainDocument),
      });
    }
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
      throw new Error("Cloud Brain authentication failed. Sign in again to reconnect.");
    const payload = await response.json().catch(() => {
      throw new Error(`Cloud Brain is unavailable (HTTP ${response.status}).`);
    });
    const body = reply(payload);
    if (!response.ok || body.error) throw new Error(body.error ?? "Cloud Brain is unavailable.");
    return body.result;
  }
  async transfer(transfer: BrainTransferRequest) {
    const receipt = transferReceipt(await this.request("transfer", { transfer }));
    this.cache?.invalidate();
    return receipt;
  }
  async state(metadataOnly = false) {
    return !metadataOnly && this.cache
      ? this.cache.state()
      : state(await this.request("state", { metadataOnly }));
  }
  async call(name: string, args: Record<string, unknown>, context: BrainSessionContext) {
    return tool(await this.request("call", { name, args, context }));
  }
  async sync(items: BrainDocumentSync[]): Promise<BrainDocumentSyncAck[]> {
    const acknowledgements = [...syncAcks(await this.request("sync", { items }))];
    if (
      acknowledgements.length !== items.length ||
      items.some(
        ({ document }) =>
          !acknowledgements.some(
            (ack) => ack.id === document.id && ack.revision === document.revision,
          ),
      )
    )
      throw new Error("Cloud Brain did not acknowledge the complete document batch.");
    this.cache?.invalidate();
    return acknowledgements;
  }
  async memories(session: string, revision?: string) {
    return memories(await this.request("memories", { context: { session }, revision }));
  }
  async document(id: string) {
    return this.cache
      ? this.cache.document(id)
      : document(await this.request("document", { name: id }));
  }
  async command(command: BrainCommand) {
    await this.request("command", { command });
    this.cache?.invalidate();
  }
  async repositories() {
    return [...repos(await this.request("repositories"))];
  }
  async branches(name: string) {
    return [...strings(await this.request("branches", { name }))];
  }
}

import { randomUUID } from "node:crypto";
import db from "../db.js";
import { encrypt, decrypt, getSetting } from "../settings.js";
import { MAX_SETUP_BYTES, validateSetupPath } from "./setup-files.js";

export interface SetupRequest {
  id: string; job: string; conversation: string; requester: string; team: string;
  channel: string; thread: string; dm?: string; dmThread?: string;
  repo: string; environment: string; destination?: string; variable?: string;
  kind: "file" | "value" | "terminal"; reason: string;
  state: "requesting" | "waiting" | "ready" | "resumed" | "completed" | "cancelled";
  encrypted?: string; resumeJob?: string; notice?: string; delivered?: boolean; createdAt: number;
  retryAt?: number; errorAttempts?: number; errorNotified?: boolean;
  lastError?: { stage: string; code: string; at: number };
}
db.exec(`CREATE TABLE IF NOT EXISTS setup_requests (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
export function requests(): SetupRequest[] {
  return (db.prepare("SELECT value FROM setup_requests").all() as { value: string }[]).map(r => JSON.parse(r.value));
}
export function getSetupRequest(id: string): SetupRequest | undefined {
  const row = db.prepare("SELECT value FROM setup_requests WHERE id = ?").get(id) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}
export function saveSetupRequest(request: SetupRequest): void {
  db.prepare("INSERT OR REPLACE INTO setup_requests (id,value) VALUES (?,?)").run(request.id, JSON.stringify(request));
}
export async function slackCall(method: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const token = getSetting("SLACK_BOT_TOKEN");
  if (!token) throw new Error("Slack is not connected");
  // files.info uses query/form parameters; unlike chat.postMessage it does not accept JSON bodies.
  const info = method === "files.info" || method === "conversations.info";
  const query = info ? `?${new URLSearchParams(Object.entries(args).map(([key, value]) => [key, String(value)]))}` : "";
  const response = await fetch(`https://slack.com/api/${method}${query}`, { method: info ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, ...(info ? {} : { body: JSON.stringify(args) }), signal: AbortSignal.timeout(30_000) });
  const body = await response.json() as Record<string, any>;
  if (!response.ok || !body.ok) {
    const code = String(body.error ?? response.status).replace(/[^a-zA-Z0-9_:-]/g, "");
    throw Object.assign(new Error(`Slack ${method} failed (${code})`), {
      code: `slack_${code}`, retryAfter: Number(response.headers.get("retry-after") ?? 0),
    });
  }
  return body;
}
export function setupUrl(id: string): string {
  const base = process.env.FLOW_PUBLIC_URL;
  if (!base) throw new Error("FLOW_PUBLIC_URL must be configured for setup terminals");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid public dashboard URL");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/setup/${id}`; url.search = ""; url.hash = "";
  return url.toString();
}
export async function createSetupRequest(input: Omit<SetupRequest, "id" | "state" | "createdAt">): Promise<SetupRequest> {
  const existing = requests().find(r => r.job === input.job && ["requesting", "waiting", "ready"].includes(r.state));
  if (existing) { if (existing.state === "requesting") await deliverSetupRequest(existing); return getSetupRequest(existing.id)!; }
  if (!["file", "value", "terminal"].includes(input.kind)) throw new Error("Choose file, value, or terminal setup");
  if (!input.requester || !input.channel || !input.thread) throw new Error("Setup requests need an originating Slack requester and thread");
  if (input.kind !== "terminal") validateSetupPath(input.destination ?? "");
  if (input.kind === "value" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.variable ?? "")) throw new Error("A value request needs an environment variable name");
  if (input.kind === "terminal") setupUrl("check");
  const request: SetupRequest = { ...input, id: randomUUID(), state: "requesting", createdAt: Date.now() };
  saveSetupRequest(request);
  await deliverSetupRequest(request);
  return getSetupRequest(request.id)!;
}
export async function deliverSetupRequest(request: SetupRequest): Promise<void> {
  if (!request.dm) {
    const result = await slackCall("conversations.open", { users: request.requester });
    request.dm = result.channel.id; saveSetupRequest(request);
  }
  const threadUrl = `https://app.slack.com/client/${encodeURIComponent(request.team)}/${request.channel}/thread/${request.channel}-${request.thread}`;
  const instruction = request.kind === "terminal"
    ? `<${setupUrl(request.id)}|Open setup terminal>, complete the installation or login, then click “Done — resume task”.`
    : request.kind === "file" ? `Reply in this DM thread with the file for \`${request.destination}\`.`
    : `Reply in this DM thread with the value for \`${request.variable}\`. I will write it to \`${request.destination}\`.`;
  const result = await slackCall("chat.postMessage", { channel: request.dm, client_msg_id: request.id,
    text: `I need some setup for ${request.repo} (${request.environment}): ${request.reason}\n\n${instruction}\nI’ll remember this setup for future tasks in this environment. Reply “cancel” to cancel this setup request.\n<${threadUrl}|Original task>` });
  request.dmThread = String(result.ts); request.state = "waiting"; saveSetupRequest(request);
}
export async function receiveSetupReply(input: { team?: string; channel: string; thread: string; user: string; text: string; files?: { id?: string }[] }): Promise<boolean> {
  const request = requests().find(r => r.dm === input.channel && r.dmThread === input.thread && r.team === (input.team ?? ""));
  if (!request) return false;
  // A DM thread is bound to one requester. Never pass rejected/raw replies to the LLM.
  if (input.user !== request.requester) return true;
  const reply = (text: string) => slackCall("chat.postMessage", { channel: request.dm, thread_ts: request.dmThread, text });
  if (input.text.trim().toLowerCase() === "cancel" && ["waiting", "ready"].includes(request.state)) {
    request.state = "cancelled"; saveSetupRequest(request); await reply("Setup request cancelled. I’ve kept the task’s work."); return true;
  }
  if (request.state !== "waiting") return true;
  try {
    if (request.kind === "terminal") {
      await reply(`Please use <${setupUrl(request.id)}|the setup terminal> and click “Done — resume task” when ready.`); return true;
    }
    let data: Buffer;
    if (request.kind === "value") {
      if (input.files?.length || !input.text.trim()) throw new Error("Reply with the requested value, or cancel this request");
      data = Buffer.from(`${request.variable}=${JSON.stringify(input.text.trim())}\n`);
    } else {
      if (input.files?.length !== 1 || !/^F[A-Z0-9]+$/.test(input.files[0].id ?? "")) throw new Error("Please attach exactly one file in this DM thread");
      const result = await slackCall("files.info", { file: input.files[0].id });
      const file = result.file;
      if (!file || file.size > MAX_SETUP_BYTES) throw new Error("Please upload a file no larger than 1 MiB");
      const url = new URL(file.url_private_download || file.url_private || "https://invalid.invalid");
      if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password) throw new Error("Unsupported Slack download URL");
      const response = await fetch(url, { headers: { authorization: `Bearer ${getSetting("SLACK_BOT_TOKEN")}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new Error("Could not download the setup file; please retry");
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > MAX_SETUP_BYTES) throw new Error("Please upload a file no larger than 1 MiB"); chunks.push(chunk); }
      data = Buffer.concat(chunks);
    }
    if (data.length > MAX_SETUP_BYTES) throw new Error("Setup value is too large");
    // Re-read after network waits: duplicate deliveries or cancellation may have won.
    if (getSetupRequest(request.id)?.state !== "waiting") return true;
    request.encrypted = encrypt(data.toString("base64")); request.state = "ready"; saveSetupRequest(request);
    await reply("Received. I’ll apply it when the machine is available and resume the original task there.");
  } catch (error) {
    // Only our fixed diagnostics are safe here; transport errors can contain URLs.
    const message = error instanceof Error && !/fetch|URL|network/i.test(error.message) ? error.message : "Could not receive the setup file; please retry.";
    await reply(message);
  }
  return true;
}
export function setupData(request: SetupRequest): Buffer {
  const data = request.encrypted ? decrypt(request.encrypted) : null;
  if (data === null) throw new Error("Setup file is unavailable");
  return Buffer.from(data, "base64");
}

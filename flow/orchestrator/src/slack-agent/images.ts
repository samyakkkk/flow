import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, existsSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export interface SlackFile { id?: string; name?: string; mimetype?: string; size?: number }
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 5;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export function imageScope(team: string, channel: string, thread: string): string {
  return createHash("sha256").update(JSON.stringify([team, channel, thread])).digest("hex");
}
function root(): string {
  return path.resolve(process.env.OPENCODE_WORKSPACE_DIR ?? path.resolve("../index-workspace"), ".flow-slack-images");
}
function directory(scope: string): string {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error("Invalid image conversation scope");
  return path.join(root(), scope);
}
export function savedImages(scope: string): string[] {
  const dir = directory(scope);
  if (!existsSync(dir)) return [];
  if (realpathSync(dir) !== path.join(realpathSync(root()), scope)) throw new Error("Invalid image storage directory");
  return readdirSync(dir).filter(name => /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(name))
    .map(name => path.join(dir, name)).filter(file => !lstatSync(file).isSymbolicLink())
    .sort((a, b) => lstatSync(a).mtimeMs - lstatSync(b).mtimeMs).slice(-MAX_IMAGES);
}
export function validateImagePaths(scope: unknown, files: unknown): string[] {
  if (files === undefined) return [];
  if (typeof scope !== "string" || !Array.isArray(files) || files.length > MAX_IMAGES) throw new Error("Invalid Slack images");
  const dir = directory(scope);
  if (files.length && !existsSync(dir)) throw new Error("Slack image is missing or outside its conversation storage");
  if (files.length && realpathSync(dir) !== path.join(realpathSync(root()), scope)) throw new Error("Invalid image storage directory");
  return files.map(file => {
    if (typeof file !== "string" || path.dirname(file) !== dir || !/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(path.basename(file)) ||
      !existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() ||
      realpathSync(file) !== path.join(realpathSync(dir), path.basename(file)) || lstatSync(file).size > MAX_IMAGE_BYTES) {
      throw new Error("Slack image is missing or outside its conversation storage");
    }
    return file;
  });
}
function actualType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0,6).toString())) return "image/gif";
  if (data.subarray(0,4).toString() === "RIFF" && data.subarray(8,12).toString() === "WEBP") return "image/webp";
}
export async function receiveImages(options: {
  scope: string; files: SlackFile[]; token: string; signal?: AbortSignal;
  info: (id: string) => Promise<{ file?: SlackFile & { url_private?: string; url_private_download?: string } }>;
  fetcher?: typeof fetch;
}): Promise<string[]> {
  const { scope, files, token, signal, info } = options;
  if (files.length > MAX_IMAGES) throw new Error("Please attach at most 5 images per message.");
  if (!token) throw new Error("Slack image access requires the bot connection to be configured.");
  const dir = directory(scope);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync(dir) !== path.join(realpathSync(root()), scope)) throw new Error("Invalid image storage directory");
  const current: string[] = [];
  for (const source of files) {
    signal?.throwIfAborted();
    if (!source.id || !/^F[A-Z0-9]+$/.test(source.id)) throw new Error("Slack attachment has no valid file ID.");
    let file;
    try { file = (await info(source.id)).file; }
    catch { throw new Error("I couldn't access the attachment. Add files:read to the Slack bot and reinstall it in this workspace, then retry."); }
    if (!file || !extensions[file.mimetype ?? ""]) throw new Error("I can currently read PNG, JPEG, GIF and WebP images. Please resend this attachment in one of those formats.");
    if ((file.size ?? 0) > MAX_IMAGE_BYTES) throw new Error("That image exceeds the 5 MiB limit. Please send a smaller image.");
    const url = new URL(file.url_private_download || file.url_private || "https://invalid.invalid");
    if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password) throw new Error("Slack returned an unsupported image download URL.");
    const response = await (options.fetcher ?? fetch)(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error("Slack image download failed. Check files:read access and retry.");
    const chunks: Uint8Array[] = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_IMAGE_BYTES) throw new Error("That image exceeds the 5 MiB limit. Please send a smaller image.");
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (actualType(data) !== file.mimetype) throw new Error("The attachment content is not a supported image.");
    const name = createHash("sha256").update(source.id).digest("hex") + "." + extensions[file.mimetype!];
    const target = path.join(dir, name);
    if (!existsSync(target) && readdirSync(dir).filter(name => !name.endsWith(".tmp")).length >= 20) {
      throw new Error("This thread has reached its 20-image storage limit. Start a new thread for more images.");
    }
    const temporary = path.join(dir, `${randomUUID()}.tmp`);
    writeFileSync(temporary, data, { mode: 0o600 }); renameSync(temporary, target);
    current.push(target);
  }
  return [...new Set([...savedImages(scope), ...current])].slice(-MAX_IMAGES);
}

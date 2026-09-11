import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { imageScope, receiveImages, savedImages, validateImagePaths, MAX_IMAGE_BYTES } from "../src/slack-agent/images.js";
const root = mkdtempSync(path.join(tmpdir(), "flow-slack-images-"));
process.env.OPENCODE_WORKSPACE_DIR = root;
process.env.DB_PATH = ":memory:";
process.env.SLACK_BOT_TOKEN = "test-image-token";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAG0lEQVR4nGP4z8BANiJf56jmUc2jmkc1U0UzADHNjoAymaoJAAAAAElFTkSuQmCC", "base64");
after(() => rmSync(root, { recursive: true, force: true }));
const metadata = { id: "F123", mimetype: "image/png", size: png.length, url_private: "https://files.slack.com/files-pri/T-F123/test.png" };
const scope = imageScope("T", "C", "1");

test("images download with Slack auth, remain private and survive follow-ups", async () => {
  const files = await receiveImages({ scope, files: [{ id: "F123" }], token: "secret", info: async () => ({ file: metadata }),
    fetcher: async (url, opts) => { assert.equal(new URL(String(url)).hostname, "files.slack.com"); assert.equal((opts?.headers as any).authorization, "Bearer secret"); assert.equal(opts?.redirect, "error"); return new Response(png); },
  });
  assert.equal(files.length, 1);
  assert.deepEqual(readFileSync(files[0]), png);
  assert.equal(statSync(files[0]).mode & 0o777, 0o600);
  assert.deepEqual(savedImages(scope), files);
  assert.deepEqual(validateImagePaths(scope, files), files);
  assert.deepEqual(savedImages(imageScope("OTHER", "C", "1")), []);
  assert.throws(() => validateImagePaths(imageScope("T", "C", "2"), files), /outside/);
  assert.throws(() => validateImagePaths(scope, ["/etc/passwd"]), /outside/);
});

test("unsupported, oversized, inaccessible and forged files fail before reaching the model", async () => {
  const base = { scope, files: [{ id: "F123" }], token: "secret" };
  await assert.rejects(receiveImages({ ...base, info: async () => { throw new Error("missing_scope"); } }), /files:read/);
  await assert.rejects(receiveImages({ ...base, info: async () => ({ file: { ...metadata, mimetype: "video/mp4" } }) }), /PNG, JPEG/);
  await assert.rejects(receiveImages({ ...base, info: async () => ({ file: { ...metadata, size: MAX_IMAGE_BYTES + 1 } }) }), /5 MiB/);
  await assert.rejects(receiveImages({ ...base, info: async () => ({ file: { ...metadata, url_private: "https://evil.example/image.png" } }) }), /unsupported image download/);
  await assert.rejects(receiveImages({ ...base, info: async () => ({ file: metadata }), fetcher: async () => new Response("<html>not an image</html>") }), /not a supported image/);
  await assert.rejects(receiveImages({ ...base, info: async () => ({ file: metadata }), fetcher: async () => new Response(Buffer.alloc(MAX_IMAGE_BYTES + 1)) }), /5 MiB/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(receiveImages({ ...base, signal: controller.signal, info: async () => ({ file: metadata }) }), /aborted/);
});

test("image-only Slack file_share events reach the runtime, and text follow-ups reuse images", async () => {
  const { registerListeners } = await import("../src/slack-agent/listeners.js");
  const handlers = new Map<string, any>();
  const queries: any[] = [];
  const app = { event(name: string, callback: any) { handlers.set(name, callback); } };
  registerListeners(app as any, { botUserId: "BOT", runtime: { name: "fixture", async ask(q) { queries.push(q); return { markdown: "image seen" }; } } });
  const fetcher = globalThis.fetch;
  globalThis.fetch = async () => new Response(png);
  const raw = { client: { files: { info: async () => ({ file: metadata }) }, conversations: { replies: async () => ({ messages: [] }) }, chat: { postMessage: async () => ({ ts: "reply" }) } },
    context: { teamId: "T" }, logger: { info() {}, warn() {}, error() {} }, say: async () => {},
  };
  try {
    await handlers.get("message")({ ...raw, event: { subtype: "file_share", user: "U", channel: "DM", channel_type: "im", ts: "1", files: [{ id: "F123" }] } });
    assert.equal(queries.length, 1);
    assert.equal(queries[0].images.length, 1);
    assert.match(queries[0].prompt, /attached image/);
    await handlers.get("message")({ ...raw, event: { user: "U", channel: "DM", channel_type: "im", ts: "2", thread_ts: "1", text: "What color was it?" } });
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[1].images, queries[0].images);
    await handlers.get("message")({ ...raw, event: { subtype: "message_changed", user: "U", channel: "DM", channel_type: "im", ts: "3", text: "ignore" } });
    assert.equal(queries.length, 2);
  } finally { globalThis.fetch = fetcher; }
});

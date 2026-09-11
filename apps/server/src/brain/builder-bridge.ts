// @effect-diagnostics nodeBuiltinImport:off - Loopback adapter for the original Flow MCP's shared embedding client.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type { BrainEmbeddings } from "./embeddings.ts";

/** Job-scoped, loopback-only endpoint. MCP borrows the app's one embedding model. */
export async function startBuilderBridge(embeddings: Pick<BrainEmbeddings, "embed">) {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const server = NodeHttp.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end("{}");
      return;
    }
    if (request.method !== "POST" || request.url !== "/embed") {
      response.writeHead(404).end("{}");
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 128_000) {
          response.writeHead(413).end("{}");
          return;
        }
      }
      const input = JSON.parse(body) as { text?: unknown };
      if (typeof input.text !== "string") {
        response.writeHead(400).end("{}");
        return;
      }
      const vec = await embeddings.embed(input.text);
      response.end(JSON.stringify({ ready: true, vec, dim: vec.length }));
    } catch {
      response.writeHead(503).end(JSON.stringify({ ready: false }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start Brain embedding bridge.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

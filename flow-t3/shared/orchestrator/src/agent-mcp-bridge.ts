// @effect-diagnostics nodeBuiltinImport:off - The MCP SDK owns Node HTTP request/response objects.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Adapt the existing job-scoped gateway to the HTTP MCP transport used by T3 providers. */
export async function startAgentMcpBridge(spec: {
  command: string; args: string[]; env: Record<string, string>; cwd: string;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
}) {
  const client = new Client({ name: "flow-brain-task", version: "1" });
  const stdio = new StdioClientTransport({ ...spec, stderr: "pipe" });
  try { await client.connect(stdio); } catch (error) { await client.close(); throw error; }
  stdio.stderr?.on("data", () => {});
  const token = randomBytes(32).toString("hex");
  const connections = new Set<Server>();
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(405).end();
      return;
    }
    let server: Server | undefined;
    try {
      let body = "";
      for await (const part of request) {
        body += String(part);
        if (body.length > 4 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
      }
      server = new Server({ name: "flow-builder", version: "1" }, { capabilities: { tools: {} } });
      connections.add(server);
      server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
      server.setRequestHandler(CallToolRequestSchema, async (call) => {
        const result = await client.callTool(call.params);
        spec.onToolCall?.(call.params.name, call.params.arguments ?? {});
        return result;
      });
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      // SDK 1.29's Node transport declares optional callbacks with explicit
      // undefined; its Transport interface omits that under exactOptionalPropertyTypes.
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      const connection = server;
      response.once("close", () => {
        connections.delete(connection);
        void connection.close();
      });
      await transport.handleRequest(request, response, JSON.parse(body));
    } catch {
      if (server) { connections.delete(server); await server.close(); }
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) { await client.close(); throw error; }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Brain task MCP unavailable.");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`, token,
    close: async () => {
      await Promise.all([...connections].map((connection) => connection.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await client.close();
    },
  };
}

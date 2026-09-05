#!/usr/bin/env node
// Thin local stdio adapter. Only the remote server reads the graph/database.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const args = {};
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[++i];
}
const config = JSON.parse(readFileSync(join(homedir(), ".flow/config.json"), "utf8"));
const project = config.projects?.[args.project];
if (!project?.mcpUrl || !project.token) throw new Error("Remote Flow project is not configured; rerun setup.");
let branch = "";
try { branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
const client = new Client({ name: "flow-connector", version: "0.1.0" });
const remote = new StreamableHTTPClientTransport(new URL(project.mcpUrl), {
  requestInit: { headers: { authorization: `Bearer ${project.token}` } },
  fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
});
const server = new Server({ name: "flow-graph", version: "0.3.0" }, {
  capabilities: { tools: {} },
  instructions: "Call orient first for project context. Use Flow's tools to consult project knowledge and memory.",
});
await client.connect(remote);
const listing = await client.listTools();
server.setRequestHandler(ListToolsRequestSchema, async () => listing);
server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = listing.tools.find(t => t.name === request.params.name);
  if (!tool) throw new Error("Unknown Flow tool");
  const input = { ...request.params.arguments };
  const properties = tool.inputSchema.properties ?? {};
  if ("repo" in properties && input.repo === undefined) input.repo = args.repo ?? "";
  if ("branch" in properties && input.branch === undefined) input.branch = branch;
  return client.callTool({ name: tool.name, arguments: input });
});
server.onclose = () => { void client.close(); };
await server.connect(new StdioServerTransport());

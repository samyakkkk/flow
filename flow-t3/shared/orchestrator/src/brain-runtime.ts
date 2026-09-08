// App-owned host for the original Flow brain. No interactive ACP sessions or
// integration pollers are started here. Database/model ownership stays with T3.
import { createHash } from "node:crypto";
import { LiveMemoryScheduler } from "./memory/live-scheduler.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sessionContext, type SessionContext } from "../../graph-gateway/src/session-context.js";

async function session(actor: string) {
  const { createSessionMcp } = await import("../../graph-gateway/src/session-mcp.js");
  const server = createSessionMcp({ graph: process.env.GRAPH_NAME!, actor });
  const client = new Client({ name: "flow-desktop", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

if (process.argv.includes("--catalog")) {
  const pair = await session("catalog");
  process.send?.({ ready: true, tools: (await pair.client.listTools()).tools });
  await pair.close();
  if (process.connected) process.disconnect();
} else {
  const { default: Fastify } = await import("fastify");
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  // Reserve the private endpoint before loading env-configured legacy modules.
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Brain endpoint unavailable");
  const url = `http://127.0.0.1:${address.port}`;
  process.env.ORCHESTRATOR_URL = url;
  process.env.GATEWAY_URL = url;
  process.env.GRAPH_GATEWAY_URL = url;
  const [{ registerMemoryRoutes, drainRemembers }, { registerCorrectionRoutes }, { default: db }, runtime, trigger, gateway] = await Promise.all([
    import("./memory/routes.js"), import("./corrections.js"), import("./db.js"),
    import("./agents/runtime.js"), import("./memory/trigger.js"), import("../../graph-gateway/src/verbs.js"),
  ]);
  const token = process.env.FLOW_ADMIN_TOKEN!;
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: "Unauthorized" });
  });
  registerMemoryRoutes(app);
  registerCorrectionRoutes(app);
  app.post<{ Params: { name: string }; Body: Record<string, unknown> }>("/v1/verbs/:name", async request =>
    gateway.callVerb(request.params.name, { ...request.body, graph: process.env.GRAPH_NAME }));
  app.post("/v1/embed", async request => {
    const response = await fetch(process.env.FLOW_EMBED_URL!, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.FLOW_EMBED_TOKEN}` },
      body: JSON.stringify(request.body), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Shared embedding service unavailable");
    return response.json();
  });
  await app.ready();
  // Atomic event receipts and transcript rows share Flow's existing SQLite DB.
  // Its checkpoint/distillation/consolidation code consumes the original event shape.
  db.exec("CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id)");
  db.exec(`CREATE TABLE IF NOT EXISTS t3_capture (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, receipt TEXT NOT NULL,
    kind TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL, UNIQUE(session, receipt))`);
  runtime.setHostedTranscriptReader(id => id.startsWith("t3-")
    ? db.prepare("SELECT seq, kind, data, ts FROM t3_capture WHERE session = ? ORDER BY seq").all(id).map((row: unknown) => {
      const r = row as { seq: number; kind: import("./agents/runtime.js").SessionEvent["kind"]; data: string; ts: number };
      return { ...r, data: JSON.parse(r.data) };
    }) : undefined);
  const capture = db.transaction((input: { context: SessionContext; receipt: string; kind: string; data: unknown; closed?: boolean }) => {
    const id = `t3-${input.context.session}`;
    db.prepare(`INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, created_at, updated_at)
      VALUES (?, 'ext:t3', ?, '', '', 'idle', ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`).run(id, input.context.repo ?? null, Date.now(), Date.now());
    db.prepare("INSERT OR IGNORE INTO t3_capture(session, receipt, kind, data, ts) VALUES (?, 't3:created', 'created', ?, ?)").run(id, JSON.stringify({ repo: input.context.repo, branch: input.context.branch, backend: "ext:t3" }), Date.now());
    db.prepare("INSERT OR IGNORE INTO t3_capture(session, receipt, kind, data, ts) VALUES (?, ?, ?, ?, ?)").run(id, input.receipt, input.kind, JSON.stringify(input.data), Date.now());
    const row = db.prepare("SELECT seq FROM t3_capture WHERE session = ? AND receipt = ?").get(id, input.receipt) as { seq: number };
    return { id, sequence: row.seq };
  });
  const live = new LiveMemoryScheduler(async id => {
    const completed = await trigger.maybeDistill(id);
    if (completed) {
      const unseen = db.prepare(`SELECT 1 FROM t3_capture WHERE session = ? AND seq > COALESCE((SELECT last_distilled_seq FROM agent_sessions WHERE id = ?), 0) LIMIT 1`).get(id, id);
      // A recovered older checkpoint may have completed after this turn was
      // already captured. Drain that newer material without waiting five minutes.
      if (unseen) live.capture(id, 0, true);
    }
    return completed;
  });
  const readMemories = (sessionId: string) => {
    const memories = db.prepare(`SELECT id, claim AS text, created_at * 1000 AS createdAt, source_weight AS origin FROM observations WHERE session_id = ? AND id NOT IN (SELECT observation_id FROM chat_memory_retired) ORDER BY created_at, id`).all(sessionId);
    const pending = db.prepare("SELECT error FROM memory_distill_jobs WHERE session_id = ? AND status = 'pending' LIMIT 1").get(sessionId) as { error: string | null } | undefined;
    const status = process.env.FLOW_DISTILLER === "0" ? "disabled" : pending?.error ? "error" : live.pending(sessionId) || pending ? "extracting" : "idle";
    const value = { memories, status };
    return { ...value, revision: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  };
  const catalog = await session("catalog");
  process.send?.({ ready: true, tools: (await catalog.client.listTools()).tools });
  await catalog.close();
  process.on("message", async (message: { id: number; method: string; params: Record<string, unknown> }) => {
    try {
      let result: unknown;
      if (message.method === "chatMemories") {
        const sessionId = `t3-${String(message.params.session)}`;
        result = readMemories(sessionId);
        if (message.params.revision && (result as { revision: string }).revision === message.params.revision) {
          const until = Date.now() + 20_000;
          while (Date.now() < until && process.connected) {
            await new Promise(resolve => setTimeout(resolve, 250));
            result = readMemories(sessionId);
            if ((result as { revision: string }).revision !== message.params.revision) break;
          }
        }
      } else if (message.method === "capture") {
        const input = message.params as Parameters<typeof capture>[0];
        const stored = capture(input);
        if (process.env.FLOW_DISTILLER !== "0") {
          const data = input.data as { content?: { text?: string }; text?: string; sessionUpdate?: string };
          const text = input.kind === "user_prompt" ? data.text ?? "" : data.sessionUpdate === "agent_message_chunk" ? data.content?.text ?? "" : "";
          live.capture(stored.id, text.length, Boolean(input.closed));
        }
        result = { stored: true, sequence: stored.sequence };
      } else if (message.method === "drain") {
        await drainRemembers();
        result = { drained: true };
      } else if (message.method === "call") {
        const context = message.params.context as SessionContext;
        const pair = await session(`t3:${context.session}`);
        try {
          result = await sessionContext.run({ ...context, session: `t3-${context.session}` }, () => pair.client.callTool({
            name: String(message.params.name), arguments: message.params.arguments as Record<string, unknown>,
          }));
        } finally { await pair.close(); }
      } else throw new Error("Unknown brain operation");
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({ id: message.id, error: error instanceof Error ? error.message : "Brain operation failed" });
    }
  });
  process.once("disconnect", () => { live.close(); trigger.stopIdleSweep(); void drainRemembers().finally(() => process.exit(0)); });
}

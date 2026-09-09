// App-owned host for the original Flow brain. No interactive ACP sessions or
// integration pollers are started here. Database/model ownership stays with T3.
import * as NodeCrypto from "node:crypto";
import { CurationCoordinator } from "./curation/coordinator.js";
import { CurationStore } from "./curation/store.js";
import { registerCuratorMcp } from "./curation/tools.js";
import { CURATION_PUBLIC_TOOLS, CurationPublicTools } from "./curation/public-tools.js";
import type { BrainCuratorReply, BrainCuratorRun } from "../../runtime/src/contracts.js";
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
  process.send?.({ ready: true, tools: [...(await pair.client.listTools()).tools,...CURATION_PUBLIC_TOOLS] });
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
  const [{ registerMemoryRoutes, drainRemembers }, { registerCorrectionRoutes }, { default: db }, runtime, gateway] = await Promise.all([
    import("./memory/routes.js"), import("./corrections.js"), import("./db.js"),
    import("./agents/runtime.js"), import("../../graph-gateway/src/verbs.js"),
  ]);
  const token = process.env.FLOW_ADMIN_TOKEN!;
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: "Unauthorized" });
  });
  registerMemoryRoutes(app, process.env.FLOW_DISTILLER === "0" ? {} : { remember: context => {
    const sessionId = context.sessionId ?? `t3-remember-${NodeCrypto.randomUUID()}`;
    const input = {context:{session:sessionId.replace(/^t3-/,""),...(context.repo ? {repo:context.repo}: {})},
      receipt:`remember:${NodeCrypto.randomUUID()}`,kind:"update",data:{sessionUpdate:"remember",text:context.text}};
    const stored = capture(input);
    if (process.env.FLOW_DISTILLER !== "0") curator.capture(stored.id,context.repo,stored.sequence,true);
  }});
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
  const capture = db.transaction((input: { context: SessionContext; receipt: string; occurredAt?: number; kind: string; data: unknown; closed?: boolean }) => {
    const id = `t3-${input.context.session}`;
    const now = Date.now();
    const occurredAt = typeof input.occurredAt === "number" && Number.isFinite(input.occurredAt) && input.occurredAt > 0
      ? Math.min(input.occurredAt, now) : now;
    db.prepare(`INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, created_at, updated_at)
      VALUES (?, 'ext:t3', ?, '', '', 'idle', ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`).run(id, input.context.repo ?? null, Date.now(), Date.now());
    db.prepare("INSERT OR IGNORE INTO t3_capture(session, receipt, kind, data, ts) VALUES (?, 't3:created', 'created', ?, ?)").run(id, JSON.stringify({ repo: input.context.repo, branch: input.context.branch, backend: "ext:t3" }), occurredAt);
    db.prepare("INSERT OR IGNORE INTO t3_capture(session, receipt, kind, data, ts) VALUES (?, ?, ?, ?, ?)").run(id, input.receipt, input.kind, JSON.stringify(input.data), occurredAt);
    const row = db.prepare("SELECT seq FROM t3_capture WHERE session = ? AND receipt = ?").get(id, input.receipt) as { seq: number };
    return { id, sequence: row.seq };
  });
  const memoryStore = await import("./memory/store.js");
  const documents = new CurationStore(db, Date.now, (id, text) => { void memoryStore.refreshMemoryEmbedding(id, text).catch(() => {}); });
  const publicDocuments = new CurationPublicTools(documents);
  let nextCuratorRequest = 0;
  const curatorRequests = new Map<number, {resolve:(result:BrainCuratorReply)=>void;reject:(error:Error)=>void}>();
  const runCurator = (curatorRun: BrainCuratorRun): Promise<BrainCuratorReply> => {
    const curatorRequest = ++nextCuratorRequest;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {curatorRequests.delete(curatorRequest);reject(new Error("The Codex extraction host did not respond."));},5*60_000);
      curatorRequests.set(curatorRequest,{
        resolve:result=>{clearTimeout(timer);resolve(result);},
        reject:error=>{clearTimeout(timer);reject(error);},
      });
      if (!process.connected) {
        curatorRequests.get(curatorRequest)!.reject(new Error("The Codex extraction host disconnected."));
        curatorRequests.delete(curatorRequest);
      } else process.send?.({curatorRequest,curatorRun});
    });
  };
  const curator = new CurationCoordinator(documents,{run:runCurator,endpoint:url,token,
    sourceReader:(name,args)=>gateway.callVerb(name,{...args,graph:process.env.GRAPH_NAME}),
    cwd:process.env.OPENCODE_WORKSPACE_DIR ?? process.cwd()});
  registerCuratorMcp(app,curator.activeTools);
  await app.ready();
  if (process.env.FLOW_DISTILLER !== "0") curator.recover();
  const readMemories = (sessionId: string) => {
    curator.open(sessionId, process.env.FLOW_DISTILLER !== "0");
    const memories = db.prepare(`SELECT id, claim AS text, created_at * 1000 AS createdAt, source_weight AS origin FROM observations WHERE session_id = ? AND id NOT IN (SELECT observation_id FROM chat_memory_retired) ORDER BY created_at, id`).all(sessionId);
    const allConsultedNodeIds = new Set<string>();
    const recentConsultedNodeIds = new Set<string>();
    const recentCutoff = Date.now() - 45_000;
    const graphRows = db.prepare("SELECT data, ts FROM t3_capture WHERE session = ? AND kind = 'graph' ORDER BY seq DESC LIMIT 100").all(sessionId) as Array<{ data: string; ts: number }>;
    for (const row of graphRows) {
      let data: { nodeIds?: unknown };
      try { data = JSON.parse(row.data) as { nodeIds?: unknown }; }
      catch { continue; }
      if (!Array.isArray(data.nodeIds)) continue;
      for (const id of data.nodeIds) {
        if (typeof id !== "string" || id.length === 0 || id.length >= 200) continue;
        if (allConsultedNodeIds.size < 100) allConsultedNodeIds.add(id);
        if (row.ts >= recentCutoff && recentConsultedNodeIds.size < 100) {
          recentConsultedNodeIds.add(id);
        }
      }
    }
    const consultedNodeIds = recentConsultedNodeIds.size > 0
      ? [...recentConsultedNodeIds]
      : [...allConsultedNodeIds];
    const extraction = documents.session(sessionId);
    const status = process.env.FLOW_DISTILLER === "0" ? "disabled" : extraction.status;
    const value = { memories, status, consultedNodeIds, notes:documents.get(`notes:${sessionId}`) ?? null,
      documents:documents.list({sessionId}).filter(doc=>doc.kind!=="notes"), extractionError:extraction.error };
    return {
      ...value,
      revision: NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    };
  };
  const catalog = await session("catalog");
  process.send?.({ ready: true, tools: [...(await catalog.client.listTools()).tools,...CURATION_PUBLIC_TOOLS] });
  await catalog.close();
  process.on("message", async (message: { id: number; method: string; params: Record<string, unknown>; curatorReply?:number;result?:BrainCuratorReply;error?:string }) => {
    if (message.curatorReply !== undefined) {
      const pending = curatorRequests.get(message.curatorReply);
      curatorRequests.delete(message.curatorReply);
      if (message.error) pending?.reject(new Error(message.error));
      else if (message.result) pending?.resolve(message.result);
      else pending?.reject(new Error("Invalid Codex extraction receipt."));
      return;
    }
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
        if (input.kind === "user_prompt") {
          const text=(input.data as {text?:unknown}).text;
          if (typeof text === "string") documents.bootstrap({sessionId:stored.id,repo:input.context.repo??null,after:0,through:stored.sequence},text);
        }
        if (process.env.FLOW_DISTILLER !== "0" && input.kind !== "graph") {
          curator.capture(stored.id,input.context.repo ?? null,stored.sequence,Boolean(input.closed));
        }
        result = { stored: true, sequence: stored.sequence };
      } else if (message.method === "drain") {
        await drainRemembers();
        await curator.flush();
        result = { drained: true };
      } else if (message.method === "documents") {
        const id = typeof message.params.id === "string" ? message.params.id : undefined;
        result = id ? documents.get(id) ?? null : documents.list().filter(doc=>doc.kind!=="notes");
      } else if (message.method === "knowledge") {
        const legacy = db.prepare("SELECT id,claim,kind,repo FROM memories WHERE status = 'active' AND ('mem:' || id) NOT IN (SELECT id FROM brain_documents) ORDER BY updated_at DESC").all() as Array<{id:string;claim:string;kind:string;repo:string|null}>;
        result = {documents:documents.list().filter(doc=>doc.kind!=="notes"),memories:legacy.map(memory=>({
          id:memory.id,kind:memory.kind==="preference"?"Preference":memory.kind==="gotcha"?"Gotcha":"Decision",
          title:memory.claim.split("\n")[0].slice(0,140),body:memory.claim,source:memory.repo??"Conversation",entityIds:[],
        }))};
      } else if (message.method === "call") {
        const context = message.params.context as SessionContext;
        const name=String(message.params.name), args=message.params.arguments as Record<string,unknown>;
        result = publicDocuments.call(name,args,`t3-${context.session}`);
        if (!result) {
          const pair = await session(`t3:${context.session}`);
          try {
            const lookup = (arguments_:Record<string,unknown>) => sessionContext.run({ ...context, session: `t3-${context.session}` }, () => pair.client.callTool({name, arguments:arguments_}));
            result = name === "get_entity" ? await publicDocuments.batch(args,`t3-${context.session}`,lookup) : undefined;
            result ??= await lookup(args);
            result = publicDocuments.augment(name,args,result);
          } finally { await pair.close(); }
        }
      } else throw new Error("Unknown brain operation");
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({ id: message.id, error: error instanceof Error ? error.message : "Brain operation failed" });
    }
  });
  process.once("disconnect", () => {
    curator.close();
    for (const request of curatorRequests.values()) request.reject(new Error("The extraction host disconnected."));
    curatorRequests.clear();
    void drainRemembers().finally(() => process.exit(0));
  });
}

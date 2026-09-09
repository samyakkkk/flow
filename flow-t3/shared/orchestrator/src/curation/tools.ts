import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { CurationStore } from "./store.js";
import {
  evidenceParts,
  excerpt,
  formatEvent,
  MAX_EVIDENCE_CHARS,
  normalizeTranscript,
  record,
  redactSecrets,
  TranscriptBudget,
} from "./transcript.js";
import type {
  CurationCheckpoint,
  DocumentKind,
  DocumentLifecycle,
  DocumentStatus,
  SaveDocument,
} from "./types.js";

const str = { type: "string" };
const num = { type: "integer" };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
export const CURATOR_TOOLS = [
  {
    name: "search_documents",
    description:
      "Find existing memories and skills by purpose before creating or changing them. Notes are scoped to this conversation.",
    inputSchema: object(
      { query: str, kind: { type: "string", enum: ["notes", "memory", "skill"] } },
      ["query"],
    ),
  },
  {
    name: "read_document",
    description:
      "Read a saved document and its revision. Large documents can be paged with offset; retain the revision for an edit.",
    inputSchema: object({ id: str, offset: num }, ["id"]),
  },
  {
    name: "write_document",
    description:
      "Save notes, a memory, or a skill in this Brain. For notes, omit id to target this conversation's notes; a chat ID is not a document ID. Use a short human-readable title for name. Cite source sequence numbers including new evidence. Existing documents require expectedRevision. For small edits provide replaceFrom/replaceTo instead of text. Skill frontmatter, including its lowercase slug, is generated from name/description.",
    inputSchema: object(
      {
        id: str,
        kind: { type: "string", enum: ["notes", "memory", "skill"] },
        name: str,
        description: str,
        text: str,
        replaceFrom: str,
        replaceTo: str,
        expectedRevision: num,
        evidence: { type: "array", items: num },
        lifecycle: { type: "string", enum: ["standing", "temporal", "issue"] },
        status: { type: "string", enum: ["active", "resolved", "superseded"] },
        halfLifeDays: { type: "number" },
      },
      ["kind", "evidence"],
    ),
  },
  {
    name: "read_evidence",
    description:
      "Fetch captured source input, output, diff, or event text by E-number. For a combined assistant passage, pass its fromSeq with part output to recover the complete source span. Credentials are redacted and embedded binary is marked as omitted; an image marker is not visual verification. No future events or current-file reconstruction. A missing output was not captured. Read only what supports the procedure or diagnosis.",
    inputSchema: object(
      {
        seq: num,
        fromSeq: num,
        part: { type: "string", enum: ["all", "input", "output", "diff"] },
        offset: num,
        limit: num,
      },
      ["seq"],
    ),
  },
  {
    name: "search_transcript",
    description:
      "Find earlier original messages and tool events in this conversation through the current checkpoint. Use when a procedure depends on context outside the current window.",
    inputSchema: object({ query: str }, ["query"]),
  },
];

export type CuratorSourceReader = (
  name: "source_read" | "source_search",
  args: Record<string, unknown>,
) => Promise<unknown>;
const SOURCE_TOOLS = [
  {
    name: "source_read",
    description:
      "Read a registered Brain repository's committed file, including an existing SKILL.md. Defaults to its indexed commit; an explicit revision must be a full commit SHA. This is reference source, not proof of what ran in the conversation. Historical edits and outputs remain in read_evidence.",
    inputSchema: object({ repo: str, path: str, revision: str, start_line: num, end_line: num }, [
      "repo",
      "path",
    ]),
  },
  {
    name: "source_search",
    description:
      "Search literal text in registered committed source to find an existing procedure, skill or implementation. Returns revision-labelled paths and lines. No current working-tree files or arbitrary filesystem paths are read.",
    inputSchema: object({ repo: str, query: str, revision: str, limit: num }, ["repo", "query"]),
  },
];

function textField(
  args: Record<string, unknown>,
  name: string,
  required = false,
): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  return value;
}
function integerField(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative integer.`);
  return value;
}
function choice<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error(`Invalid ${name}.`);
  return value as T;
}
export class CuratorTools {
  private calls = 0;
  private legacyReads = new Map<string, string>();
  exchangedCharacters = 0;
  constructor(
    readonly store: CurationStore,
    readonly checkpoint: CurationCheckpoint,
    readonly budget: TranscriptBudget,
    readonly sourceReader?: CuratorSourceReader,
  ) {}
  async executeAsync(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== "source_read" && name !== "source_search") return this.execute(name, args);
    if (!this.sourceReader)
      throw new Error(
        "Registered repository source access is unavailable in this extraction host.",
      );
    if (++this.calls > 32)
      throw new Error("Checkpoint tool limit reached. Finish this checkpoint.");
    this.exchangedCharacters += JSON.stringify(args).length;
    try {
      if (this.budget.remaining < 500)
        throw new Error("Evidence budget exhausted. Finish this checkpoint.");
      const input: Record<string, unknown> = { repo: textField(args, "repo", true)! };
      const revision = textField(args, "revision");
      if (revision) input.revision = revision;
      if (name === "source_read") {
        input.path = textField(args, "path", true)!;
        const start = integerField(args, "start_line", 1);
        input.start_line = start;
        input.end_line = Math.min(integerField(args, "end_line", start + 99), start + 199);
      } else {
        input.query = textField(args, "query", true)!;
        input.limit = Math.min(20, Math.max(1, integerField(args, "limit", 10)));
      }
      const response = await this.sourceReader(name, input);
      const metadata = record(response);
      if (metadata.status === "error")
        throw new Error(
          redactSecrets(String(metadata.error ?? "Registered source is unavailable.")).slice(
            0,
            1000,
          ),
        );
      const text = redactSecrets(JSON.stringify(response));
      const limit = Math.min(MAX_EVIDENCE_CHARS, Math.floor((this.budget.remaining - 400) / 2));
      const result = {
        source: "Registered committed source; reference context, not a historical execution result",
        repo: metadata.repo,
        revision: metadata.revision,
        excerpt: excerpt(text, limit),
        omitted: text.length > limit,
      };
      const characters = JSON.stringify(result).length;
      if (!this.budget.canAppend(characters))
        throw new Error("Evidence budget exhausted. Finish this checkpoint.");
      this.budget.append(characters);
      this.exchangedCharacters += characters;
      return result;
    } catch (error) {
      this.exchangedCharacters += error instanceof Error ? error.message.length : 100;
      throw error;
    }
  }
  execute(name: string, args: Record<string, unknown>): unknown {
    this.exchangedCharacters += JSON.stringify(args).length;
    try {
      const result = this.perform(name, args);
      this.exchangedCharacters += JSON.stringify(result).length;
      return result;
    } catch (error) {
      this.exchangedCharacters += error instanceof Error ? error.message.length : 100;
      throw error;
    }
  }
  private perform(name: string, args: Record<string, unknown>): unknown {
    if (++this.calls > 32)
      throw new Error(
        "Checkpoint tool limit reached. Preserve established notes and finish; further investigation can continue at the next checkpoint.",
      );
    const cp = this.checkpoint;
    if (name === "search_documents") {
      const query = textField(args, "query", true)!;
      const kind = choice<DocumentKind>(args.kind, ["notes", "memory", "skill"], "document kind");
      return this.store.search(query, kind, 12, { notesSessionId: cp.sessionId });
    }
    if (name === "read_document") {
      const doc = this.store.get(textField(args, "id", true)!);
      if (!doc || (doc.kind === "notes" && doc.sessionId !== cp.sessionId))
        throw new Error("Document not found in this scope.");
      const offset = integerField(args, "offset", 0);
      if (doc.revision === 0) this.legacyReads.set(doc.id, doc.text);
      const { text, ...summary } = doc;
      return {
        ...summary,
        text: text.slice(offset, offset + 12000),
        totalCharacters: text.length,
        nextOffset: offset + 12000 < text.length ? offset + 12000 : null,
      };
    }
    if (name === "write_document") {
      const kind = choice<DocumentKind>(args.kind, ["notes", "memory", "skill"], "document kind");
      if (!kind) throw new Error("Document kind is required.");
      if (
        !Array.isArray(args.evidence) ||
        args.evidence.length > 100 ||
        !args.evidence.every(
          (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
        )
      )
        throw new Error("Supply up to 100 real source sequence numbers.");
      const input: SaveDocument = { kind, evidence: args.evidence as number[] };
      for (const key of [
        "id",
        "name",
        "description",
        "text",
        "replaceFrom",
        "replaceTo",
      ] as const) {
        const value = textField(args, key);
        if (value !== undefined) input[key] = value;
      }
      if (args.expectedRevision !== undefined)
        input.expectedRevision = integerField(args, "expectedRevision", 0);
      const lifecycle = choice<DocumentLifecycle>(
        args.lifecycle,
        ["standing", "temporal", "issue"],
        "lifecycle",
      );
      const status = choice<DocumentStatus>(
        args.status,
        ["active", "resolved", "superseded"],
        "status",
      );
      if (lifecycle) input.lifecycle = lifecycle;
      if (status) input.status = status;
      if (args.halfLifeDays !== undefined) {
        if (typeof args.halfLifeDays !== "number")
          throw new Error("halfLifeDays must be a number.");
        input.halfLifeDays = args.halfLifeDays;
      }
      if (input.id && this.legacyReads.has(input.id))
        input.expectedLegacyText = this.legacyReads.get(input.id)!;
      const doc = this.store.save(cp, input);
      return { id: doc.id, revision: doc.revision, characters: doc.text.length, saved: true };
    }
    if (name === "read_evidence") {
      const seq = integerField(args, "seq", 0);
      if (!seq || seq > cp.through) throw new Error("Evidence is unavailable at this checkpoint.");
      const row = this.store.readCapture(cp.sessionId, seq - 1, seq)[0];
      if (!row) throw new Error("Evidence is unavailable at this checkpoint.");
      const part =
        choice(args.part, ["all", "input", "output", "diff"] as const, "evidence part") ?? "all";
      const fromSeq = integerField(args, "fromSeq", seq);
      if (!fromSeq || fromSeq > seq) throw new Error("Invalid evidence source range.");
      let text = evidenceParts(row)[part] ?? "";
      if (fromSeq < seq) {
        if (part !== "all" && part !== "output")
          throw new Error("Assistant source ranges support all or output evidence.");
        const rows = this.store.readCapture(cp.sessionId, fromSeq - 1, seq);
        if (
          rows[0]?.seq !== fromSeq ||
          rows.at(-1)?.seq !== seq ||
          rows.some(
            (source) =>
              source.kind !== "update" ||
              record(source.data).sessionUpdate !== "agent_message_chunk",
          )
        )
          throw new Error(
            "The source range must contain only consecutive assistant fragments in this chat.",
          );
        // Both views return the complete prose. Serializing fragments separately
        // would hide a credential split across deltas from the redactor.
        text = redactSecrets(
          rows.map((source) => String(record(record(source.data).content).text ?? "")).join(""),
        );
      }
      const offset = integerField(args, "offset", 0);
      const requested = Math.min(
        MAX_EVIDENCE_CHARS,
        Math.max(100, integerField(args, "limit", 4000)),
      );
      if (this.budget.remaining < 500)
        throw new Error(
          "Evidence budget exhausted. Finish this checkpoint; the next run can renew its context.",
        );
      let limit = Math.min(requested, this.budget.remaining - 250);
      const result = {
        seq,
        ...(fromSeq < seq ? { fromSeq } : {}),
        part,
        text: text.slice(offset, offset + limit),
        totalCharacters: text.length,
        nextOffset: offset + limit < text.length ? offset + limit : null,
      };
      let characters = JSON.stringify(result).length;
      // Escaped output can occupy more context than the original string. Keep
      // a useful page instead of rejecting a read that still has room to fit.
      while (!this.budget.canAppend(characters) && limit > 0) {
        limit = Math.floor(limit / 2);
        result.text = text.slice(offset, offset + limit);
        result.nextOffset = offset + limit < text.length ? offset + limit : null;
        characters = JSON.stringify(result).length;
      }
      this.budget.append(characters);
      return result;
    }
    if (name === "search_transcript") {
      const words =
        textField(args, "query", true)!
          .toLowerCase()
          .match(/[\p{L}\p{N}_-]+/gu) ?? [];
      const hits = normalizeTranscript(this.store.readCapture(cp.sessionId, 0, cp.through))
        .map((event) => ({
          event,
          score: words.reduce((n, word) => n + Number(event.text.toLowerCase().includes(word)), 0),
        }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || b.event.seq - a.event.seq)
        .slice(0, 6)
        .map((hit) => ({
          seq: hit.event.seq,
          ...(hit.event.fromSeq !== undefined ? { fromSeq: hit.event.fromSeq } : {}),
          excerpt: excerpt(formatEvent(hit.event), 600),
        }));
      if (!this.budget.canAppend(JSON.stringify(hits).length))
        throw new Error("Evidence budget exhausted. Finish this checkpoint.");
      this.budget.append(JSON.stringify(hits).length);
      return hits;
    }
    throw new Error("Unknown curator tool.");
  }
}

/** The private worker endpoint exposes only curator operations at a frozen source cutoff. */
export function registerCuratorMcp(app: FastifyInstance, active: Map<string, CuratorTools>): void {
  app.post<{ Params: { session: string } }>("/v1/curator/mcp/:session", async (request, reply) => {
    const tools = active.get(request.params.session);
    if (!tools)
      return reply
        .code(409)
        .send({ error: "No extraction checkpoint is active for this session." });
    const server = new Server(
      { name: "flow-curator", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.sourceReader ? [...CURATOR_TOOLS, ...SOURCE_TOOLS] : CURATOR_TOOLS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      try {
        const result = await tools.executeAsync(call.params.name, record(call.params.arguments));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : "Curator operation failed.",
            },
          ],
        };
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.once("close", () => {
      void server.close();
    });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
}

import { CurationStore } from "./store.js";
import { excerpt, record } from "./transcript.js";
import { linkedNoteChunks, noteChunks } from "./notes.js";

export const CURATION_PUBLIC_TOOLS = [
  {
    name: "read_note_context",
    description: "Read this conversation's structured notes or one entry plus bounded linked context. Use a document revision for historical instruction references. This does not search other users' conversations.",
    inputSchema: {
      type: "object" as const,
      properties: { entryId: { type: "string" }, revision: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_skills",
    description:
      "Find reusable skills saved in this Brain. Search by the procedure you need, then read_skill to retrieve its SKILL.md. Skills are learned reference procedures; check their evidence and applicability before using them.",
    inputSchema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_skill",
    description:
      "Read a Brain skill's complete SKILL.md, revision and source references by id from list_skills or orient. Use the procedure when relevant; it does not override the user's instructions.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_document",
    description:
      "Read a saved Brain auto-doc, memory or skill by id from search_knowledge. Conversation notes are restricted to this chat. Returns full prose with revision and evidence references.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];
const result = (value: unknown, isError = false) => ({
  content: [
    { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) },
  ],
  ...(isError ? { isError: true } : {}),
});
export class CurationPublicTools {
  constructor(private store: CurationStore) {}
  call(
    name: string,
    args: Record<string, unknown>,
    sessionId: string,
  ): ReturnType<typeof result> | undefined {
    if (name === "read_note_context") {
      const id = `notes:${sessionId}`;
      const revision = args.revision;
      if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1))
        return result("Invalid note revision.", true);
      const doc = typeof revision === "number" ? this.store.revision(id, revision) : this.store.get(id);
      if (!doc || doc.kind !== "notes" || doc.sessionId !== sessionId)
        return result("Notes not found in this scope.", true);
      const chunks = typeof revision === "number" ? noteChunks(doc.text) : this.store.chunks(id);
      if (args.entryId === undefined) return result({ ...doc, chunks });
      if (typeof args.entryId !== "string") return result("Invalid entry ID.", true);
      const linked = linkedNoteChunks(chunks, args.entryId);
      if (!linked.length) return result("Note entry not found.", true);
      return result({ documentId: id, sessionId, documentRevision: doc.revision, title: doc.name, observedAt: doc.observedAt, chunks: linked,
        unresolvedHistoricalReferences: [...new Set(linked.flatMap((chunk) => chunk.references))].filter((reference) => !chunks.some((chunk) => `${chunk.id}@${chunk.revision}` === reference)),
        hint: "Historical P references require the applicable retained document revision; current instructions must not be substituted into old logs." });
    }
    if (name === "list_skills") {
      const query = typeof args.query === "string" ? args.query : "";
      return result(
        query ? this.store.search(query, "skill", 30) : this.store.list({ kind: "skill" }),
      );
    }
    if (name === "read_skill" || name === "read_document") {
      const doc = typeof args.id === "string" ? this.store.get(args.id) : undefined;
      if (
        !doc ||
        (name === "read_skill" && doc.kind !== "skill") ||
        (doc.kind === "notes" && doc.sessionId !== sessionId)
      )
        return result("Document not found in this scope.", true);
      return result({ ...doc, evidence: this.store.evidence(doc.id) });
    }
    if (name === "get_entity" && typeof args.id === "string" && !args.id.startsWith("mem:")) {
      const doc = this.store.get(args.id);
      if (doc && doc.revision > 0 && (doc.kind !== "notes" || doc.sessionId === sessionId))
        return result({ ...doc, evidence: this.store.evidence(doc.id) });
    }
    return undefined;
  }
  async batch(
    args: Record<string, unknown>,
    sessionId: string,
    lookup: (args: Record<string, unknown>) => Promise<unknown>,
  ): Promise<ReturnType<typeof result> | undefined> {
    if (
      typeof args.id === "string" ||
      !Array.isArray(args.ids) ||
      !args.ids.length ||
      args.ids.length > 15 ||
      !args.ids.every((id) => typeof id === "string" && id.length > 0)
    )
      return undefined;
    const ids = args.ids as string[];
    const documents = ids
      .map((id) => (id.startsWith("mem:") ? undefined : this.store.get(id)))
      .map((doc) => (doc && doc.revision > 0 ? doc : undefined));
    if (!documents.some(Boolean)) return undefined;
    const graphIds = ids.filter((_, index) => !documents[index]);
    let graphResults: unknown[] = [];
    if (graphIds.length) {
      const response = record(await lookup({ ...args, ids: graphIds }));
      const content = Array.isArray(response.content) ? response.content : [];
      try {
        const payload = record(JSON.parse(String(record(content[0]).text)));
        if (Array.isArray(payload.results)) graphResults = payload.results;
      } catch {
        /* Preserve an explicit per-id failure if the underlying response cannot be decoded. */
      }
    }
    let graphIndex = 0;
    const results = ids.map((id, index) => {
      const doc = documents[index];
      if (!doc)
        return (
          graphResults[graphIndex++] ?? {
            id,
            status: "error",
            error: "The graph lookup did not return this entry.",
          }
        );
      return doc.kind === "notes" && doc.sessionId !== sessionId
        ? { id, status: "not_found" }
        : { id, status: "found", document: { ...doc, evidence: this.store.evidence(id) } };
    });
    return result({
      status: "batch",
      count: results.length,
      found: results.filter((value) => record(value).status === "found").length,
      not_found: results
        .filter((value) => record(value).status === "not_found")
        .map((value) => record(value).id),
      results,
    });
  }
  augment(name: string, args: Record<string, unknown>, response: unknown): unknown {
    let text = "";
    if (name === "orient") {
      const skills = this.store.list({ kind: "skill" });
      const docs = this.store.list({ kind: "doc" });
      if (docs.length) text += `\nAUTO-DOCS: ${docs.length} maintained context documents are available through search_knowledge and read_document.\n`;
      if (skills.length)
        text +=
          `\nSKILLS (${skills.length}): reusable procedures learned from conversations. Call read_skill with an id to fetch the full SKILL.md; list_skills searches by purpose.\n` +
          skills
            .slice(0, 30)
            .map((skill) => `- ${skill.name} [${skill.id}]: ${skill.description}`)
            .join("\n") +
          (skills.length > 30 ? "\nUse list_skills for the remaining skills." : "");
    } else if (name === "search_knowledge") {
      const queries =
        typeof args.query === "string"
          ? [args.query]
          : Array.isArray(args.queries)
            ? args.queries.filter((q): q is string => typeof q === "string")
            : [];
      text = queries
        .map((query) => {
          // New documents have conversation provenance, not graph-node/channel anchors.
          // Do not broaden a caller's explicit anchored or corpus-only scope.
          if (/(?:^|\s)(?:node:|channel:|sort:recent|type:(?:thread|ticket)\b)/i.test(query))
            return "";
          const memoryOnly = /(?:^|\s)type:memory\b/i.test(query);
          const search = query.replace(/(?:^|\s)type:memory\b/gi, " ").trim();
          const hits = this.store.search(
            search,
            memoryOnly ? "memory" : undefined,
            typeof args.limit === "number" ? args.limit : 12,
            { notesSessionId: false, includeLegacy: false },
          );
          return hits.length
            ? `Curated documents for ${JSON.stringify(query)}:\n${hits.map((doc) => `- ${doc.kind} ${doc.name} [${doc.id}] (${doc.lifecycle}, ${doc.status}): ${excerpt(this.store.get(doc.id)!.text, 1200)}\nFetch full text with read_document.`).join("\n")}`
            : "";
        })
        .filter(Boolean)
        .join("\n\n");
    }
    if (!text) return response;
    const original = record(response);
    const content = Array.isArray(original.content) ? original.content : [];
    if (name === "search_knowledge") {
      // Preserve the existing JSON search envelope so every client can keep
      // rendering semantic results instead of a JSON blob followed by prose.
      const first = record(content[0]);
      try {
        const payload = record(JSON.parse(String(first.text)));
        if (typeof payload.results === "string") {
          const augmented = { ...payload, results: `${payload.results}\n\n${text}` };
          return {
            ...original,
            ...(original.structuredContent ? { structuredContent: augmented } : {}),
            content: [{ ...first, text: JSON.stringify(augmented) }, ...content.slice(1)],
          };
        }
      } catch {
        /* A prose-only response can be extended as another text block. */
      }
    }
    return { ...original, content: [...content, { type: "text", text }] };
  }
}

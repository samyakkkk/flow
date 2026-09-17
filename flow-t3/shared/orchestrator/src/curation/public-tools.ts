import { CurationStore } from "./store.js";
import { excerpt, record } from "./transcript.js";
import type { BrainDocumentSummary, DocumentKind } from "./types.js";

// Brain documents (conversation notes, maintained docs, skills) are opened with
// get_entity like every other id an agent is handed; this class answers those
// calls from the curation store and leaves graph nodes and cards to the gateway.
// Conversation notes are readable across chats: a new conversation must be able
// to pick up where a previous one left off.
const result = (value: unknown, isError = false) => ({
  content: [
    { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) },
  ],
  ...(isError ? { isError: true } : {}),
});
// `type:<kind>` tokens narrow a search to one document kind; ticket/thread kinds
// belong to the graph corpus and are left to the gateway untouched.
const KIND_TOKEN = /(?:^|\s)type:(skill|notes|doc)\b/i;
const NO_MATCH = "(nothing matched — try symptoms, identifiers, or file paths)";
// Put each query's documents inside that query's section of the search result, and
// drop the "nothing matched" line when documents did match.
function placeDocuments(results: string, queries: string[], blocks: string[]): string {
  if (queries.length === 1 && !results.startsWith("=== q1: "))
    return results.trim() === NO_MATCH ? blocks[0]! : `${results}\n\n${blocks[0]}`;
  let placed = results;
  const loose: string[] = [];
  queries.forEach((query, index) => {
    const block = blocks[index];
    if (!block) return;
    const header = `=== q${index + 1}: ${query} ===\n`;
    const start = placed.indexOf(header);
    if (start < 0) return void loose.push(block);
    const bodyStart = start + header.length;
    const next = placed.indexOf("\n=== q", bodyStart);
    const end = next < 0 ? placed.length : next;
    const body = placed.slice(bodyStart, end).trim();
    placed = `${placed.slice(0, bodyStart)}${body === NO_MATCH ? block : `${body}\n\n${block}`}${next < 0 ? "" : "\n"}${placed.slice(end)}`;
  });
  return loose.length ? `${placed}\n\n${loose.join("\n\n")}` : placed;
}
const RECENT_CONVERSATIONS = 6;
const ago = (at: number) => {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
};
export class CurationPublicTools {
  constructor(private store: CurationStore) {}
  // Until extraction names a conversation its notes carry a placeholder title;
  // the opening words of the original request say more.
  private title(doc: BrainDocumentSummary): string {
    if (doc.name !== "Conversation notes") return doc.name;
    const request = /^> (.+)$/m.exec(this.store.get(doc.id)?.text ?? "")?.[1]?.trim();
    return request ? JSON.stringify(request.length > 70 ? request.slice(0, 69) + "…" : request) : doc.name;
  }
  private titles(label: string, noun: string, docs: BrainDocumentSummary[], shown: number, kind: DocumentKind): string {
    if (!docs.length) return "";
    const rest = docs.length > shown ? `; newest ${shown} shown, search_knowledge type:${kind} for the rest` : "";
    return `\n${label} (${docs.length} ${noun}${rest}):\n${docs.slice(0, shown).map((doc) => `- ${doc.name} [${doc.id}]`).join("\n")}\n`;
  }
  call(name: string, args: Record<string, unknown>): ReturnType<typeof result> | undefined {
    if (name === "get_entity" && typeof args.id === "string" && !args.id.startsWith("mem:")) {
      const doc = this.store.get(args.id);
      if (doc && doc.revision > 0) return result({ ...doc, evidence: this.store.evidence(doc.id) });
    }
    return undefined;
  }
  async batch(
    args: Record<string, unknown>,
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
      return { id, status: "found", document: { ...doc, evidence: this.store.evidence(id) } };
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
  // sessionId is the calling conversation: orient names its notes document so the
  // agent can re-read them after compaction without a dedicated tool.
  augment(name: string, args: Record<string, unknown>, response: unknown, sessionId?: string): unknown {
    let text = "";
    let queries: string[] = [];
    let blocks: string[] = [];
    if (name === "orient") {
      if (sessionId) text += `\nTHIS CONVERSATION: notes are [notes:${sessionId}] — get_entity to recover earlier decisions after compaction.\n`;
      const recent = this.store
        .list({ kind: "notes" })
        .filter((doc) => doc.sessionId !== sessionId)
        .slice(0, RECENT_CONVERSATIONS);
      if (recent.length)
        text +=
          "\nRECENT CONVERSATIONS (newest first; get_entity an id to pick that work up):\n" +
          recent.map((doc) => `- ${this.title(doc)} — ${ago(doc.updatedAt)} [${doc.id}]`).join("\n") +
          "\n";
      text += this.titles("DOCS", "maintained", this.store.list({ kind: "doc" }), 8, "doc");
      text += this.titles("SKILLS", "learned procedures", this.store.list({ kind: "skill" }), 12, "skill");
      text += "\nTOOLS: search_knowledge (what was written down) · find_entity (code by intent) · get_entity [id] opens anything · read_query (connections, blast radius) · remember · correct_graph\n";
    } else if (name === "search_knowledge") {
      queries = (
        typeof args.query === "string"
          ? [args.query]
          : Array.isArray(args.queries)
            ? args.queries.filter((q): q is string => typeof q === "string")
            : []
      )
        .map((query) => query.trim())
        .filter(Boolean);
      blocks = queries.map((query) => {
        // Graph-anchored and corpus-only scopes are the gateway's; do not broaden them.
        if (/(?:^|\s)(?:node:|channel:|sort:recent|type:(?:memory|thread|ticket)\b)/i.test(query)) return "";
        const kind = KIND_TOKEN.exec(query)?.[1]?.toLowerCase() as DocumentKind | undefined;
        const hits = this.store.search(
          query.replace(KIND_TOKEN, " ").trim(),
          kind,
          typeof args.limit === "number" ? args.limit : 12,
          { includeLegacy: false, excludeMemories: true },
        );
        return hits.length
          ? `Documents (get_entity [id] reads any of these in full):\n${hits.map((doc) => `- ${doc.kind} ${doc.name} [${doc.id}] (${doc.lifecycle}, ${doc.status}): ${excerpt(this.store.get(doc.id)!.text, 1200)}`).join("\n")}`
          : "";
      });
      text = blocks.filter(Boolean).join("\n\n");
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
          const augmented = { ...payload, results: placeDocuments(payload.results, queries, blocks) };
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

/** Search chunks are derived from maintained notes; they are never authored separately. */
export interface NoteChunk {
  id: string;
  kind: "continuation" | "preference" | "log" | "finding" | "legacy";
  revision: number;
  title: string;
  text: string;
  references: string[];
  evidence: number[];
}

export function noteChunks(markdown: string): NoteChunk[] {
  const chunks: NoteChunk[] = [];
  let heading: { id: string; kind: NoteChunk["kind"]; revision: number; title: string } | undefined;
  let body: string[] = [];
  let fenced = false;
  const flush = () => {
    if (heading) {
      const text = body.join("\n").trim();
      chunks.push({
        ...heading,
        text,
        references: [...new Set(text.match(/\bP[1-9]\d*@(?:[1-9]\d*)\b/g) ?? [])],
        evidence: [...new Set([...text.matchAll(/\bE([1-9]\d*)\b/g)].map((match) => Number(match[1])))],
      });
    }
    body = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^##\s/.test(line)) {
      flush();
      heading = /^## Continue this work\s*$/.test(line)
        ? { id: "continuation", kind: "continuation", revision: 1, title: "Continue this work" }
        : undefined;
      continue;
    }
    const match = !fenced && line.match(/^### ([PLF][1-9]\d*)(?:@([1-9]\d*))?\s+[—–-]\s+(.+)$/);
    if (match) {
      flush();
      const id = match[1]!;
      if (id.startsWith("P") && !match[2]) throw new Error(`${id} needs an instruction revision, e.g. ${id}@1.`);
      heading = {
        id,
        kind: id.startsWith("P") ? "preference" : id.startsWith("L") ? "log" : "finding",
        revision: Number(match[2] ?? 1),
        title: match[3]!.trim(),
      };
    } else body.push(line);
  }
  flush();
  if (!chunks.length) return [{ id: "legacy", kind: "legacy", revision: 1, title: "Conversation notes", text: markdown, references: [], evidence: [] }];
  const ids = new Set<string>();
  for (const chunk of chunks) {
    if (ids.has(chunk.id)) throw new Error(`Duplicate note entry ${chunk.id}.`);
    ids.add(chunk.id);
    if (!chunk.text) throw new Error(`Note entry ${chunk.id} is empty.`);
    if (chunk.kind !== "continuation" && !chunk.evidence.length)
      throw new Error(`Note entry ${chunk.id} needs source E-number citations.`);
  }
  return chunks;
}

/** Resolve explicit links in both directions without recursively pulling the entire chat. */
export function linkedNoteChunks(chunks: NoteChunk[], id: string, limit = 6): NoteChunk[] {
  const selected = chunks.find((chunk) => chunk.id === id);
  if (!selected) return [];
  const reference = `${selected.id}@${selected.revision}`;
  return [selected, ...chunks.filter((chunk) => chunk.id !== id && (
    chunk.references.includes(reference) || selected.references.includes(`${chunk.id}@${chunk.revision}`)
  )).slice(0, Math.max(0, limit - 1))];
}

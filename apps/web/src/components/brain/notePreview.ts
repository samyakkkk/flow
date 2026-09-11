export type NotePreview = { title: string; sections: { label: string; text: string }[] };

/** A presentation-only projection. Unknown layouts keep the original text preview. */
export function notePreview(markdown: string): NotePreview | null {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  // Do not interpret sample headings inside code as the real handoff.
  if (lines.some(line => /^\s*(```|~~~)/.test(line))) return null;
  const start = lines.findIndex(line => /^## Continue this work\s*$/i.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  if (!body) return null;
  const plain = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
  const title = plain(lines.find(line => /^#\s+/.test(line))?.replace(/^#\s+/, "") ?? "Current conversation");
  const sections: NotePreview["sections"] = [];
  // Labels must begin a line; a sentence mentioning "next action" isn't a task.
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?(Goal(?: and why)?|Current state|Completed(?: work)?|Progress|Discoveries|Verification(?: status)?|Blockers(?:\/open questions)?|Open questions|Next(?: requested\/proposed)?(?: action| steps?| tasks?))(?:\*\*)?:\s*(?:\*\*)?\s*(.*)$/i);
    if (match) sections.push({ label: plain(match[1]!), text: plain(match[2]!) });
    else if (sections.length) sections[sections.length - 1]!.text += `\n${plain(line)}`;
    else if (line.trim()) sections.push({ label: "Current state", text: plain(line) });
  }
  const populated = sections.filter(section => section.text.trim());
  // Put explicit upcoming work first, retaining the source's wording/qualifiers.
  populated.sort((a, b) => Number(/^Next/i.test(b.label)) - Number(/^Next/i.test(a.label)));
  return populated.length ? { title, sections: populated.slice(0, 4) } : null;
}

// contextblock.ts — Render the "CONTEXT BY FLOW" markdown section idempotently.
// The section lives between <!-- flow:context:start --> and <!-- flow:context:end --> markers.
// Rule: exactly one such section per ticket body; re-render replaces in place.
// This file is a pure function — no DB or network calls — so it can be unit-tested cheaply.

const START_MARKER = "<!-- flow:context:start -->";
const END_MARKER = "<!-- flow:context:end -->";

export interface ContextBundle {
  // Knowledge graph context for this ticket
  relatedNodes?: Array<{ id: string; name: string; type: string; description?: string }>;
  // Relevant Slack messages
  slackMentions?: Array<{ ts: string; text: string; channel?: string; permalink?: string }>;
  // Any additional freeform notes
  notes?: string;
}

/**
 * Render a context bundle into the markdown section string (including markers).
 */
export function renderContextBlock(bundle: ContextBundle): string {
  const lines: string[] = [START_MARKER, "", "**CONTEXT BY FLOW**", ""];

  if (bundle.relatedNodes && bundle.relatedNodes.length > 0) {
    lines.push("### Related Knowledge Graph Nodes", "");
    for (const node of bundle.relatedNodes) {
      lines.push(`- **[${node.type}]** \`${node.id}\` — ${node.name}${node.description ? `: ${node.description}` : ""}`);
    }
    lines.push("");
  }

  if (bundle.slackMentions && bundle.slackMentions.length > 0) {
    lines.push("### Related Slack Discussions", "");
    for (const msg of bundle.slackMentions) {
      const link = msg.permalink ? ` ([link](${msg.permalink}))` : "";
      lines.push(`- ${msg.text.slice(0, 120)}${msg.text.length > 120 ? "..." : ""}${link}`);
    }
    lines.push("");
  }

  if (bundle.notes) {
    lines.push("### Notes", "", bundle.notes, "");
  }

  lines.push(END_MARKER);
  return lines.join("\n");
}

/**
 * Insert or replace the CONTEXT BY FLOW section in a ticket body.
 * Idempotent: calling twice with the same bundle produces the same output as calling once.
 *
 * @param body   Current ticket description markdown
 * @param bundle Context to render
 * @returns      Updated body with exactly one context section
 */
export function upsertContextBlock(body: string, bundle: ContextBundle): string {
  const block = renderContextBlock(bundle);
  const startIdx = body.indexOf(START_MARKER);
  const endIdx = body.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing block (inclusive of both markers)
    return (
      body.slice(0, startIdx) +
      block +
      body.slice(endIdx + END_MARKER.length)
    );
  }

  // No existing block — append after a blank line separator
  const separator = body.trimEnd().length > 0 ? "\n\n" : "";
  return body.trimEnd() + separator + block;
}

/**
 * Check whether a body already contains a Flow context block.
 */
export function hasContextBlock(body: string): boolean {
  return body.includes(START_MARKER) && body.includes(END_MARKER);
}

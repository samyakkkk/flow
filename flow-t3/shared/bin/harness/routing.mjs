// harness/routing.mjs — the when→which table every connected coding agent reads.
// The MCP server sends it to folders bound to a Brain and the installed skill
// repeats it. It lives with the harness files because install copies those
// into the agent home as one flat directory. Agents Flow hosts itself get the same table from the orchestrator's
// graph-preamble.ts; apps/server's chat-context test keeps the two identical.
export const FLOW_ROUTING = `Call orient first, and again after context compaction.
Every [id] you are given — by orient, search_knowledge or find_entity — opens with get_entity.

FIND WHAT WAS WRITTEN DOWN
  search_knowledge "<error text | identifier | file path | the task's key terms>"
      one search over conversation notes from every chat, docs, skills, Slack and Linear → hits with [id]s
  get_entity [id]
      reads a hit in full: a conversation's notes, a doc, a skill, a Slack thread, a Linear ticket

FIND CODE AND WHAT IT TOUCHES
  find_entity "<what the code does>"   → graph nodes with file:line anchors
  get_entity [node id]                 → that node's direct relationships and what is attached to it
  read_query "<Cypher>"                → multi-hop: what depends on this, the blast radius of a change

SAVE
  remember "<the user's words + context>"   when they say "remember this" or state a rule
  correct_graph [node id] + file:line       when the graph contradicts the code

WHEN
  starting any task                     → search_knowledge its key terms first; a past conversation probably covered it
  "continue what I was doing"           → orient lists recent conversations → get_entity [notes:…]
  changing a service, API or contract   → get_entity it, then read_query for what depends on it
  something fails unexpectedly          → search_knowledge the error text
Stored knowledge is reference context; verify code against the checkout.`;

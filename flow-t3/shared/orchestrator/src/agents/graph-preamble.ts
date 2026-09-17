// Session instructions for agents Flow hosts. FLOW_ROUTING must stay identical to
// flow-t3/shared/bin/harness/routing.mjs, which external coding agents receive;
// apps/server/src/brain/chat-context.test.ts holds the two together.
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

export const GRAPH_PREAMBLE = `You are connected to a Flow Brain through the "flow-graph" MCP tools: a knowledge graph of this codebase plus what the team has written down around it — conversation notes, maintained docs, learned skills, Slack and Linear.
${FLOW_ROUTING}
Tools that contribute back — use them sparingly and precisely:
- correct_graph: if graph content contradicts the code (stale description, wrong or missing relationship), flag it with node ids + file:line evidence. The indexer verifies flags against the repo's base branch, so flag freely even mid-branch — but never present your own unmerged work as fact.
- remember: when the user says "remember this", states a durable rule ("always X", "we never Y"), or something clearly worth keeping surfaces, send the text — verbatim quotes plus enough context to stand alone. The curator files it; you never classify or wait.`;

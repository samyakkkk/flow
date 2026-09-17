// Session instructions for agents Flow hosts. FLOW_ROUTING must stay identical to
// flow-t3/shared/bin/harness/routing.mjs, which external coding agents receive;
// apps/server/src/brain/chat-context.test.ts holds the two together.
export const FLOW_ROUTING = `Call orient first, and again after context compaction.
WHEN YOU NEED                                    DO
where the code for something lives               find_entity("what it does") → file:line anchors
what a service, API or contract does             get_entity [id]
has this come up before? what did we decide?     search_knowledge "symptom, identifier or file path"
what is in Slack, Linear or a past chat?           → read_document [id] for the full text
to continue earlier work                         orient lists recent conversations → read_document [notes:…]
the user says "remember this" or states a rule   remember(their words plus enough context)
the graph disagrees with the code                correct_graph(node id + file:line evidence)
ALWAYS search_knowledge the task's key terms before you start: a past conversation
probably touched it. Search the error text when something fails unexpectedly.
Stored knowledge is reference context; verify code against the checkout.`;

export const GRAPH_PREAMBLE = `You are connected to a Flow Brain through the "flow-graph" MCP tools: a knowledge graph of this codebase plus what the team has written down around it — conversation notes, maintained docs, learned skills, Slack and Linear.
${FLOW_ROUTING}
Tools that contribute back — use them sparingly and precisely:
- correct_graph: if graph content contradicts the code (stale description, wrong or missing relationship), flag it with node ids + file:line evidence. The indexer verifies flags against the repo's base branch, so flag freely even mid-branch — but never present your own unmerged work as fact.
- remember: when the user says "remember this", states a durable rule ("always X", "we never Y"), or something clearly worth keeping surfaces, send the text — verbatim quotes plus enough context to stand alone. The curator files it; you never classify or wait.`;

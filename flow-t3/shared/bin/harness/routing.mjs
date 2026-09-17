// harness/routing.mjs — the when→which table every connected coding agent reads.
// The MCP server sends it to folders bound to a Brain and the installed skill
// repeats it. It lives with the harness files because install copies those
// into the agent home as one flat directory. Agents Flow hosts itself get the same table from the orchestrator's
// graph-preamble.ts; apps/server's chat-context test keeps the two identical.
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

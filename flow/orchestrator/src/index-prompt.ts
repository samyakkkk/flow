// Shared by the original orchestrator and the app-managed Brain runtime.
// Keep the full and incremental prompts in one place.
export function indexRepoPrompt(
  repo: string,
  branch: string,
  inc?: { from: string; to: string; stat: string } | null,
) {
  if (inc) {
    return {
      agent: "graph-builder",
      prompt: `The repository repos/${repo} (branch ${branch}) was updated from ${inc.from} to ${inc.to}. Changed files:

${inc.stat}

Read the actual diff with git (cd repos/${repo} && git diff ${inc.from}..${inc.to} -- <paths>) for anything that looks behavioral. Decide what changed in *behavior* terms — new/changed/removed capabilities, endpoints, resources, or usage-contract conditions. Refactors that move code without changing behavior need no graph writes.

Update the knowledge graph accordingly: enrich or correct existing entities, update contracts whose uses/sensitive_to conditions changed, add new entities for genuinely new behavior, and update evidence on anything you re-verified. Finish with a short summary of what changed in the graph and why, or state that no durable behavior changed.`,
    };
  }
  return {
    agent: "graph-builder",
    prompt: `Index the repository at repos/${repo} (branch ${branch}) into the knowledge graph. The graph may already contain entities from other repositories — check what exists before creating (graph_find_entity), reuse and enrich existing entities, and pay special attention to cross-repo dependencies. Write incrementally as you learn, per your instructions. Finish with a summary of what you modeled and any open questions.`,
  };
}

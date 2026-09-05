import { type Plugin, tool } from "@opencode-ai/plugin";
import { createCloudToolPolicy, CLOUD_AGENT_PROMPT, CLOUD_PERMISSIONS } from "./cloud-tool-policy.js";
import type { CloudRepo } from "./cloud-workspaces.js";

// Loaded by absolute file URL only for cloud chat processes, never by local
// ACP agents or graph builders. The job token cannot choose a conversation.
const cloudPlugin: Plugin = async ({ directory }) => {
  if (process.env.FLOW_MODE !== "prod" || !process.env.FLOW_JOB_ID || !process.env.FLOW_JOB_TOKEN) {
    throw new Error("Cloud plugin requires a prod job identity");
  }
  const endpoint = `${process.env.ORCHESTRATOR_URL}/v1/agents/tasks/${encodeURIComponent(process.env.FLOW_JOB_ID)}/workspace`;
  async function workspace(repo?: string, edit = false): Promise<CloudRepo[]> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.FLOW_JOB_TOKEN}` },
      body: JSON.stringify({ repo, edit }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.json() as { repos?: CloudRepo[]; error?: string };
    if (!response.ok || !body.repos) throw new Error(body.error ?? `Workspace request failed (${response.status})`);
    return body.repos;
  }
  const guard = createCloudToolPolicy({
    directory,
    repos: () => workspace(),
    ensure: async (repo) => {
      const result = (await workspace(repo, true)).find((r) => r.name === repo);
      if (!result) throw new Error(`Worktree missing for ${repo}`);
      return result;
    },
  });
  return {
    config: async (config) => {
      config.permission = { ...CLOUD_PERMISSIONS };
      config.agent = { ...config.agent, "flow-cloud": {
        mode: "primary", prompt: CLOUD_AGENT_PROMPT, permission: { ...CLOUD_PERMISSIONS },
      } };
    },
    tool: {
      flow_workspace: tool({
        description: "List registered repos and this conversation's worktrees. With repo and edit=true, prepare or reuse its worktree for requested edits. Questions do not need one.",
        args: { repo: tool.schema.string().optional(), edit: tool.schema.boolean().optional() },
        async execute(args) { return JSON.stringify({ repos: await workspace(args.repo, args.edit) }); },
      }),
    },
    "tool.execute.before": async (input, output) => guard(input.tool, output.args),
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(CLOUD_AGENT_PROMPT, JSON.stringify({ repos: await workspace() }));
    },
  };
};

export default cloudPlugin;

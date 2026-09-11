import { brainResourceEnvironment } from "@flow/brain-runtime";
// @effect-diagnostics nodeBuiltinImport:off - Native CLI boundary.
// SPDX-License-Identifier: AGPL-3.0-only
import type { BrainCli } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { INDEXER_DEFAULT_MODELS } from "../../../../flow-t3/shared/orchestrator/src/indexer-defaults.ts";
import { indexRepoPrompt } from "../../../../flow-t3/shared/orchestrator/src/index-prompt.ts";
import {
  startActivity,
  recordActivityLine,
  finishActivity,
  activityForRepo,
} from "../../../../flow-t3/shared/orchestrator/src/job-activity.ts";
import { builderAsset, builderMcpCommand } from "./builder-assets.ts";
import { run, runStreaming } from "./process.ts";

export interface BuilderContext {
  platform: NodeJS.Platform;
  graph: string;
  socket: string;
  embedUrl: string;
  embedToken: string;
  workspace: string;
  branch: string;
  previousCommit?: string | undefined;
  previousBranch?: string | undefined;
  onActivity: (activity: ReturnType<typeof activityForRepo>) => void;
}

// Same ancestor/diff-size gate as Flow's original incrementalContext.
export async function incrementalContext(
  repoPath: string,
  branch: string,
  previousBranch?: string,
  previousCommit?: string,
) {
  if (!previousCommit || branch !== previousBranch) return null;
  try {
    await run("git", ["merge-base", "--is-ancestor", previousCommit, "HEAD"], { cwd: repoPath });
    const head = await run("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    if (head === previousCommit) return null;
    const stat = await run("git", ["diff", "--stat", `${previousCommit}..HEAD`], { cwd: repoPath });
    const changed = stat.trim().split("\n").length - 1;
    return changed >= 1 && changed <= 200
      ? { from: previousCommit, to: head, stat: stat.trim() }
      : null;
  } catch {
    return null;
  }
}

export async function indexRepository(
  cli: BrainCli,
  repository: string,
  repoPath: string,
  jobPath: string,
  signal: AbortSignal,
  context: BuilderContext,
) {
  await NodeFSP.mkdir(jobPath, { recursive: true, mode: 0o700 });
  const markdown = builderAsset(".opencode/agents/graph-builder.md");
  const instructions = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  const inc = await incrementalContext(
    repoPath,
    context.branch,
    context.previousBranch,
    context.previousCommit,
  );
  const { prompt } = indexRepoPrompt(repository, context.branch, inc);
  await NodeFSP.writeFile(NodePath.join(context.workspace, "AGENTS.md"), builderAsset("AGENTS.md"));
  const agentDirectory = NodePath.join(context.workspace, ".opencode", "agents");
  await NodeFSP.mkdir(agentDirectory, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(agentDirectory, "graph-builder.md"), markdown);
  const spec = builderMcpCommand();
  const jobId = NodePath.basename(jobPath);
  const env = {
    ELECTRON_RUN_AS_NODE: "1",
    FLOW_MAINTENANCE_GRAPH: "",
    GATEWAY_MCP_MODE: "builder",
    GATEWAY_MCP_READONLY: "0",
    ...brainResourceEnvironment({
      graphName: context.graph,
      databaseSocket: context.socket,
      embeddingUrl: `${context.embedUrl}/embed`,
      embeddingToken: context.embedToken,
    }),
    FLOW_FIXED_GRAPH: context.graph,
    EMBEDDING_MODEL: "local:embeddinggemma-300M-Q8_0",
    FLOW_ACTOR: `${cli}:graph-builder:${jobId}`,
    JOURNAL_PATH: NodePath.join(context.workspace, "journal.jsonl"),
    WORKSPACE_DIR: context.workspace,
    OPENCODE_WORKSPACE_DIR: context.workspace,
    FLOW_MEMORY_URL: "",
    ORCHESTRATOR_URL: context.embedUrl,
    FLOW_ACTIVITY_URL: "",
    FLOW_JOB_ID: "",
    FLOW_WRITE_SCOPE: "",
  };
  const mcp = { ...spec, env };
  const config = NodePath.join(jobPath, "mcp.json");
  await NodeFSP.writeFile(config, JSON.stringify({ mcpServers: { "flow-graph": mcp } }), {
    mode: 0o600,
  });
  let args: string[];
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  };
  delete childEnv.FLOW_ADMIN_TOKEN;
  const model = process.env.GRAPH_BUILDER_MODEL ?? INDEXER_DEFAULT_MODELS[cli];
  if (cli === "claude") {
    args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
      "--append-system-prompt",
      instructions,
      "--mcp-config",
      config,
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__flow-graph,Read,Grep,Glob,LS,Bash(git:*)",
      "--disallowedTools",
      "Write,Edit,NotebookEdit,WebFetch,WebSearch",
      "--",
      prompt,
    ];
  } else if (cli === "codex") {
    const toml = (s: string) => JSON.stringify(s);
    args = [
      "exec",
      "--json",
      "-m",
      model,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--output-last-message",
      NodePath.join(jobPath, "summary.md"),
    ];
    const overrides = [
      `mcp_servers.flow-graph.command=${toml(spec.command)}`,
      `mcp_servers.flow-graph.args=[${spec.args.map(toml).join(",")}]`,
      `mcp_servers.flow-graph.env={${Object.entries(env)
        .map(([k, v]) => `${k}=${toml(v)}`)
        .join(",")}}`,
    ];
    for (const override of overrides) args.push("-c", override);
    args.push(`${instructions}\n\n${prompt}`);
  } else {
    childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      mcp: {
        "flow-graph": {
          type: "local",
          command: [spec.command, ...spec.args],
          environment: env,
          enabled: true,
        },
      },
    });
    args = [
      "run",
      "--format",
      "json",
      "-m",
      model,
      "--dir",
      context.workspace,
      "--agent",
      "graph-builder",
      "--",
      prompt,
    ];
  }
  // Keep the exact instructions/request with the job, not a regenerated approximation.
  await NodeFSP.writeFile(NodePath.join(jobPath, "prompt.md"), `${instructions}\n\n${prompt}`, {
    mode: 0o600,
  });
  let summary = "";
  let providerError = false;
  let rateLimited = false;
  const activityKey = `${context.graph}/${repository}`;
  startActivity(jobId, activityKey, cli);
  let success = false;
  const maintain = () =>
    run(spec.command, spec.args, {
      cwd: context.workspace,
      signal,
      timeout: 45 * 60_000,
      env: { ...childEnv, FLOW_MAINTENANCE_GRAPH: context.graph },
    });
  try {
    await maintain();
    await runStreaming(cli, args, {
      platform: context.platform,
      cwd: context.workspace,
      env: childEnv,
      signal,
      timeout: 45 * 60_000,
      transcript: NodePath.join(jobPath, "transcript.jsonl"),
      onLine(line) {
        recordActivityLine(jobId, cli, line);
        context.onActivity(activityForRepo(activityKey));
        try {
          const event = JSON.parse(line);
          if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected")
            rateLimited = true;
          if (event.type === "result") {
            summary = event.result ?? "";
            providerError ||= event.is_error === true;
          }
          if (event.type === "error" || event.type === "turn.failed") providerError = true;
          if (event.type === "text" && event.part?.text) summary += event.part.text;
        } catch {
          /* diagnostics are retained in transcript */
        }
      },
    });
    if (providerError)
      throw new Error(
        "The indexing CLI reported a failure. The graph already written is preserved; check sign-in or usage limits and retry.",
      );
    if (cli === "codex")
      summary = await NodeFSP.readFile(NodePath.join(jobPath, "summary.md"), "utf8");
    else await NodeFSP.writeFile(NodePath.join(jobPath, "summary.md"), summary, { mode: 0o600 });
    await maintain();
    success = true;
    return { summary, incremental: Boolean(inc) };
  } catch (error) {
    if (rateLimited)
      throw new Error(
        "Claude has reached its session usage limit. Retry after the limit resets, or choose another indexing CLI in Brain settings.",
        { cause: error },
      );
    throw error;
  } finally {
    // Snapshot before Flow's live-only activity buffer is cleared on finish.
    context.onActivity(activityForRepo(activityKey));
    finishActivity(jobId, success ? "done" : "failed");
    await NodeFSP.rm(config, { force: true });
  }
}

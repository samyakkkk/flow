// integrations.ts — dashboard-triggered `flow setup`: connect a local folder
// to THIS project and materialize harness integrations into it, plus the
// status/detection reads the home page renders.
//
// The orchestrator can do this because in local mode it runs on the same
// machine (and as the same user) as the folders being connected — it simply
// imports the CLI's materializer. This whole surface is meaningless for a
// remote (EC2) orchestrator, where file-writing is `flow connect`/`flow
// setup`'s job on the laptop; the dashboard shows the manual path there.

import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { FLOW_ROOT, GATEWAY_MCP, binPath, projectGraphName } from "./agents/runtime.js";
import { addWorkFolder } from "./work-folders.js";

const PROJECT_DIR = dirname(process.env.DB_PATH ?? join(FLOW_ROOT, "data", "flow.db"));

interface Materializer {
  materializeMachine(args: Record<string, unknown>): void;
  materializeRepo(ctx: Record<string, unknown>): { owned: string[]; merged: string[] };
  removeRepo(repoDir: string): void;
  detectHarnesses(): string[];
  ALL_HARNESSES: string[];
  ATOMS_VERSION: number;
}

async function materializer(): Promise<Materializer> {
  return (await import(join(FLOW_ROOT, "bin", "lib", "materialize.mjs"))) as unknown as Materializer;
}

function projectName(): string {
  try {
    const pj = JSON.parse(readFileSync(join(PROJECT_DIR, "project.json"), "utf8"));
    if (typeof pj.name === "string" && pj.name) return pj.name;
  } catch {
    /* fall through */
  }
  return basename(PROJECT_DIR);
}

function normalizeGitUrl(u: string): string {
  return u
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function resolveRepoName(repoDir: string): { name: string; registered: boolean } {
  let repos: Array<{ name: string; url?: string; localPath?: string }> = [];
  try {
    const p = process.env.REPOS_JSON_PATH;
    if (p && existsSync(p)) repos = (JSON.parse(readFileSync(p, "utf8")).repos ?? []) as typeof repos;
  } catch {
    /* no registry */
  }
  const byPath = repos.find((r) => r.localPath === repoDir);
  if (byPath) return { name: byPath.name, registered: true };
  try {
    const origin = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (origin) {
      const norm = normalizeGitUrl(origin);
      const byUrl = repos.find((r) => r.url && normalizeGitUrl(r.url) === norm);
      if (byUrl) return { name: byUrl.name, registered: true };
    }
  } catch {
    /* no origin */
  }
  const byName = repos.find((r) => r.name === basename(repoDir));
  if (byName) return { name: byName.name, registered: true };
  return { name: basename(repoDir), registered: false };
}

export function registerIntegrationRoutes(app: FastifyInstance): void {
  // Connected repos (this machine's manifest, filtered to THIS project) +
  // what tools this machine has — one payload for the home-page section.
  app.get("/v1/integrations/status", async () => {
    const m = await materializer();
    const name = projectName();
    let manifest: { repos?: Record<string, Record<string, unknown>> } = {};
    try {
      manifest = JSON.parse(readFileSync(join(process.env.HOME ?? "", ".flow", "integrations.json"), "utf8"));
    } catch {
      /* none yet */
    }
    const repos = Object.entries(manifest.repos ?? {})
      .filter(([, v]) => v.project === name)
      .map(([path, v]) => ({
        path,
        repo: v.repo,
        harnesses: v.harnesses,
        version: v.version,
        share: v.share === true,
        at: v.at,
        stale: (v.version as number) !== m.ATOMS_VERSION,
      }));
    return { project: name, repos, detected: m.detectHarnesses(), all: m.ALL_HARNESSES, version: m.ATOMS_VERSION };
  });

  app.post<{ Body: { path?: string; harnesses?: string[]; share?: boolean; all?: boolean } }>(
    "/v1/integrations/setup",
    async (req, reply) => {
      const { path, harnesses, share, all } = req.body ?? {};
      if (!path || !existsSync(path)) return reply.code(400).send({ error: "path required and must exist" });
      let repoDir: string;
      try {
        repoDir = execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: path,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
      } catch {
        return reply.code(400).send({ error: "not a git repository — Flow connects git repos" });
      }

      const m = await materializer();
      const name = projectName();
      const orchPort = process.env.ORCHESTRATOR_PORT ?? "7500";
      const gatewayUrl = (process.env.GATEWAY_URL ?? "http://127.0.0.1:7433").replace(/\/+$/, "");
      const { name: repoName, registered } = resolveRepoName(repoDir);

      m.materializeMachine({
        flowRoot: FLOW_ROOT,
        projectName: name,
        shimSource: join(FLOW_ROOT, "bin", "harness", "flow-hook.mjs"),
        projectEntry: {
          remote: "local",
          orchestratorUrl: `http://localhost:${orchPort}`,
          gatewayUrl,
          graphName: projectGraphName(),
          token: process.env.FLOW_ADMIN_TOKEN ?? "dev-token",
          falkorHost: process.env.FALKOR_HOST ?? "localhost",
          falkorPort: Number(process.env.FALKOR_PORT ?? 6379),
          tsxBin: binPath("tsx"),
          gatewayMcp: GATEWAY_MCP,
        },
      });

      const chosen =
        harnesses?.filter((h) => m.ALL_HARNESSES.includes(h)) ??
        (all ? m.ALL_HARNESSES : m.detectHarnesses());
      const useHarnesses = chosen.length ? chosen : m.ALL_HARNESSES;
      const { owned, merged } = m.materializeRepo({
        repoDir,
        project: name,
        repo: repoName,
        share: share === true,
        harnesses: useHarnesses,
      });
      addWorkFolder("local", repoDir, registered ? repoName : undefined);
      return { ok: true, repoDir, repo: repoName, registered, harnesses: useHarnesses, files: [...owned, ...merged] };
    }
  );

  app.post<{ Body: { path?: string } }>("/v1/integrations/remove", async (req, reply) => {
    const { path } = req.body ?? {};
    if (!path) return reply.code(400).send({ error: "path required" });
    const m = await materializer();
    m.removeRepo(path);
    return { ok: true };
  });
}

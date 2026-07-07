// lib/docker.mjs — FalkorDB Docker container management.
//
// Container name: flow-falkordb
// Image:          falkordb/falkordb:latest
// Port:           6379

import { execSync, spawnSync } from "node:child_process";

const CONTAINER_NAME = "flow-falkordb";
const IMAGE = "falkordb/falkordb:latest";

/**
 * Ensure the flow-falkordb container is running.
 * Starts it if stopped; runs it if it doesn't exist.
 * Returns true on success, throws on unrecoverable error.
 */
export async function ensureFalkordb() {
  // Check inspect status
  const inspect = spawnSync("docker", ["inspect", CONTAINER_NAME, "--format", "{{.State.Status}}"], {
    encoding: "utf-8",
  });

  // Returns a status string so the caller controls output:
  // "running" (already up), "started" (was stopped), "launched" (created).
  if (inspect.status === 0) {
    const status = inspect.stdout.trim();
    if (status === "running") return "running";
    if (status === "exited" || status === "stopped") {
      execSync(`docker start ${CONTAINER_NAME}`, { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 1500));
      return "started";
    }
  }

  // Container doesn't exist — run it
  execSync(`docker run -d --name ${CONTAINER_NAME} -p 6379:6379 ${IMAGE}`, { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 2000));
  return "launched";
}

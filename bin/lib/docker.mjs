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

  if (inspect.status === 0) {
    const status = inspect.stdout.trim();
    if (status === "running") {
      console.log(`  [docker] ${CONTAINER_NAME} already running`);
      return true;
    }
    if (status === "exited" || status === "stopped") {
      console.log(`  [docker] starting existing container ${CONTAINER_NAME}...`);
      execSync(`docker start ${CONTAINER_NAME}`, { stdio: "inherit" });
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    }
  }

  // Container doesn't exist — run it
  console.log(`  [docker] launching ${CONTAINER_NAME} (${IMAGE})...`);
  execSync(
    `docker run -d --name ${CONTAINER_NAME} -p 6379:6379 ${IMAGE}`,
    { stdio: "inherit" }
  );
  await new Promise((r) => setTimeout(r, 2000));
  return true;
}

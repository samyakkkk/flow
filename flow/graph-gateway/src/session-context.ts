import { AsyncLocalStorage } from "node:async_hooks";

// App hosts may serve several sessions concurrently in one brain process.
// Keep session identity out of process.env; standalone deployments retain their defaults.
export interface SessionContext { repo?: string; branch?: string; session?: string }
export const sessionContext = new AsyncLocalStorage<SessionContext>();
export function sessionValue(key: "FLOW_REPO" | "FLOW_BRANCH" | "FLOW_AGENT_SESSION") {
  const field = { FLOW_REPO: "repo", FLOW_BRANCH: "branch", FLOW_AGENT_SESSION: "session" } as const;
  return sessionContext.getStore()?.[field[key]] ?? process.env[key];
}

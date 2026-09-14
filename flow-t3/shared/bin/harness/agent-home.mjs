import { homedir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Installed shims resolve their own registry even when an editor strips environment variables.
export function agentHome() {
  if (process.env.FLOW_AGENT_HOME) return process.env.FLOW_AGENT_HOME;
  const directory = dirname(fileURLToPath(import.meta.url));
  return basename(directory) === 'bin' ? dirname(directory) : join(homedir(), '.flow');
}

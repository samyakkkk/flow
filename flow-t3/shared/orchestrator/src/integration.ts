import type Database from "better-sqlite3";

/** A deployment may supply private integrations to its isolated Brain worker.
 * The module path is trusted host configuration, never a remote request field.
 * Storage and reads stay in that Brain's process and resource boundary.
 */
export interface BrainWorkerIntegrationHost {
  database: Database.Database;
  tools: readonly { name: string; description?: string; inputSchema: Record<string, unknown> }[];
  call(name: string, args: Record<string, unknown>, session: string): Promise<unknown>;
}
export interface BrainWorkerIntegration {
  configure(config: unknown): Promise<unknown>;
  action(action: string): Promise<unknown>;
  close(): Promise<unknown>;
}
export type BrainWorkerIntegrationFactory = (host: BrainWorkerIntegrationHost) => BrainWorkerIntegration | Promise<BrainWorkerIntegration>;

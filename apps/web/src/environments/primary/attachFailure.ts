import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopAttachFailure } from "@t3tools/contracts";

/**
 * Why the desktop could not attach to the Flow service, if that is what
 * happened. The desktop bridge parks the failure on the primary bootstrap with
 * null endpoints, so this is a synchronous read of a fact the main process
 * already decided — the renderer never probes for it.
 *
 * Null everywhere else: browser hosts have no bridge, and a desktop that
 * attached has no failure to report.
 */
export function readPrimaryAttachFailure(): DesktopAttachFailure | null {
  const bootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
  const primary = bootstraps.find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
  return primary?.attachFailure ?? null;
}

import type { BrainCli, BrainCommand, BrainResponse } from "@t3tools/contracts";

/**
 * Shared shape of the "connect to an existing remote Brain" form. Both the
 * Brain page dialogs and the onboarding wizard collect these three fields and
 * must keep the same validation, trimming and failure copy, so the rules live
 * here rather than in each surface.
 */
export interface ConnectCloudFields {
  readonly endpoint: string;
  readonly email: string;
  readonly password: string;
  /** CLI that curates conversation notes on this machine. Omitted keeps the remote Brain's choice. */
  readonly cli?: BrainCli | undefined;
}

export const CONNECT_CLOUD_ERROR =
  "Could not connect to this Brain. Check the URL, email, and password and retry.";

/** All three fields are required; endpoint and email are trimmed before the check. */
export const connectCloudReady = (fields: ConnectCloudFields) =>
  fields.endpoint.trim() !== "" && fields.email.trim() !== "" && fields.password !== "";

/** The exact command sent for a connect. Password is passed through untouched. */
export function connectCloudCommand(
  fields: ConnectCloudFields,
  workspaceId?: string,
): BrainCommand {
  return {
    action: "connectCloud",
    ...(workspaceId ? { workspaceId } : {}),
    endpoint: fields.endpoint.trim(),
    email: fields.email.trim(),
    password: fields.password,
    ...(fields.cli ? { cli: fields.cli } : {}),
  };
}

export type ConnectCloudOutcome =
  | { readonly ok: true; readonly workspaceId: string }
  | { readonly ok: false; readonly error: string };

/**
 * Normalizes a brain response into "connected" or "failed with a message".
 * Callers that run the command through an atom pass `null` for a transport
 * failure so the fallback copy is used.
 */
export function connectCloudOutcome(
  response: BrainResponse | null | undefined,
  fallback: string = CONNECT_CLOUD_ERROR,
): ConnectCloudOutcome {
  if (!response || response.error || !response.createdWorkspaceId)
    return { ok: false, error: response?.error ?? fallback };
  return { ok: true, workspaceId: response.createdWorkspaceId };
}

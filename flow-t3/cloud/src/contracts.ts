import type { BrainCapture, BrainSessionContext } from "@flow/brain-runtime";

/** Implemented by a remote client/private deployment, never by a local fallback. */
export interface CloudBrainConnection<Tool, Result> {
  readonly brainId: string;
  tools(): Promise<readonly Tool[]>;
  call(name: string, args: Record<string, unknown>, context: BrainSessionContext): Promise<Result>;
  capture(event: BrainCapture): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}
export interface CloudBrainConnector<Tool, Result> {
  connect(input: {
    endpoint: string;
    brainId: string;
    /** The private host authorizes the brain and session on every operation. */
    getAccessToken: () => Promise<string>;
  }): Promise<CloudBrainConnection<Tool, Result>>;
}

export type DocumentKind = "notes" | "memory" | "skill";
export type DocumentLifecycle = "standing" | "temporal" | "issue";
export type DocumentStatus = "active" | "resolved" | "superseded";

export interface BrainDocumentSummary {
  id: string;
  kind: DocumentKind;
  name: string;
  description: string;
  revision: number;
  sessionId: string;
  repo: string | null;
  lifecycle: DocumentLifecycle;
  status: DocumentStatus;
  halfLifeDays: number | null;
  createdAt: number;
  updatedAt: number;
  observedAt: number;
}
export interface BrainDocument extends BrainDocumentSummary {
  text: string;
}
export interface CaptureRow {
  seq: number;
  kind: string;
  data: unknown;
  ts: number;
}
export interface TranscriptEvent {
  seq: number;
  fromSeq?: number;
  at: number;
  kind: "user" | "assistant" | "tool" | "boundary" | "nomination";
  text: string;
}
export interface CurationCheckpoint {
  sessionId: string;
  repo: string | null;
  after: number;
  through: number;
}
export interface SaveDocument {
  id?: string;
  kind: DocumentKind;
  name?: string;
  description?: string;
  text?: string;
  replaceFrom?: string;
  replaceTo?: string;
  expectedRevision?: number;
  /** Host-supplied read snapshot when refining a legacy memory for the first time. */
  expectedLegacyText?: string;
  evidence: number[];
  lifecycle?: DocumentLifecycle;
  status?: DocumentStatus;
  halfLifeDays?: number | null;
}
export interface CurationSession {
  sessionId: string;
  lastSeq: number;
  status: "idle" | "extracting" | "error";
  error: string | null;
  updatedAt: number;
}

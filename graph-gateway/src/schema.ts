// The ontology the gateway enforces. Writes with types outside these lists are
// rejected — this is the discipline layer that prompts can't provide.
// Extend deliberately; every addition is a modeling decision.

export const NODE_TYPES = [
  "Service",
  "Repository",
  "APIEndpoint",
  "Handler",
  "Capability",
  "UsageContract",
  "Database",
  "DatabaseTable",
  "S3Bucket",
  "Queue",
  "Cache",
  "AWSResource",
  "ExternalService",
  "Workflow",
  "Concept",
  "Procedure",
  "Note",
] as const;

export const EDGE_TYPES = [
  "OWNS",
  "CALLS",
  "CALLS_WITH_CONTRACT",
  "CALLER",
  "CALLEE",
  "USES_CAPABILITY",
  "DOES_NOT_USE",
  "PROVIDES_CAPABILITY",
  "EXPOSES_CAPABILITY",
  "IMPLEMENTS_CAPABILITY",
  "HANDLED_BY",
  "READS",
  "WRITES",
  "TOUCHES",
  "USES",
  "DEFINES",
  "PUBLISHES",
  "DISPATCHES_TO",
  "RELATES_TO",
  "GOVERNS",
  "ANNOTATES",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];
export type EdgeType = (typeof EDGE_TYPES)[number];

export function isNodeType(t: string): t is NodeType {
  return (NODE_TYPES as readonly string[]).includes(t);
}

export function isEdgeType(t: string): t is EdgeType {
  return (EDGE_TYPES as readonly string[]).includes(t);
}

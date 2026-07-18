// parse.ts — robustly pull the distiller's JSON array out of a model reply.
// Adapted from flow-benchmarks/memory-evals/distiller/parse.mjs.
//
// Handles: markdown fences, leading prose, and the "[] then reconsider then the
// real array" pattern — we scan for every TOP-LEVEL [...] block and take the
// LAST one that parses as an array. Also validates each element into a typed
// RawObservation, dropping malformed ones rather than throwing.

export type ObservationKind = "decision" | "constraint" | "gotcha" | "how_to" | "preference" | "plan";
export type ObservationSource = "user_stated" | "agent_inferred" | "error_proven";

export interface RawObservation {
  claim: string;
  kind: ObservationKind;
  context: { repo?: string; branch?: string; files?: string[] };
  source: ObservationSource;
  retrieval_keys: string[];
}

const KINDS: ReadonlySet<string> = new Set(["decision", "constraint", "gotcha", "how_to", "preference", "plan"]);
const SOURCES: ReadonlySet<string> = new Set(["user_stated", "agent_inferred", "error_proven"]);

// Return every top-level bracket block, then take the LAST that JSON-parses to
// an array. Returns [] when nothing parses (an empty array is a valid answer).
export function extractArray(result: string): unknown[] {
  if (typeof result !== "string") return [];
  const s = result.trim();
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try previous candidate */
    }
  }
  return [];
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

// Validate one raw element into a RawObservation, or null if unusable.
export function validateObservation(raw: unknown): RawObservation | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const claim = typeof o.claim === "string" ? o.claim.trim() : "";
  if (!claim) return null;
  const kind = KINDS.has(o.kind as string) ? (o.kind as ObservationKind) : null;
  if (!kind) return null;
  const source = SOURCES.has(o.source as string) ? (o.source as ObservationSource) : "agent_inferred";
  const ctx = (o.context ?? {}) as Record<string, unknown>;
  return {
    claim,
    kind,
    source,
    context: {
      repo: typeof ctx.repo === "string" ? ctx.repo : undefined,
      branch: typeof ctx.branch === "string" ? ctx.branch : undefined,
      files: toStringArray(ctx.files),
    },
    retrieval_keys: toStringArray(o.retrieval_keys),
  };
}

// Parse a full model reply into a validated observation list.
export function parseObservations(modelReply: string): RawObservation[] {
  const arr = extractArray(modelReply);
  const out: RawObservation[] = [];
  for (const el of arr) {
    const v = validateObservation(el);
    if (v) out.push(v);
  }
  return out;
}

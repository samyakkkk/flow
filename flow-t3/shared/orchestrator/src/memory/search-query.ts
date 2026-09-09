// Pure query parsing shared by legacy and curated knowledge retrieval.
// Node-scoped + type filters parsed out of the query string (Section E). A
// caller can write `node:svc:users type:memory hmac` and get memories anchored
// to svc:users matching "hmac"; the tokens are stripped before FTS/embedding so
// they don't pollute the meaningful-token match. `node` / `type` params take
// precedence over the in-query tokens when both are given.
export type SearchTypeFilter = "memory" | "ticket" | "thread";
const TYPE_FILTERS = new Set<SearchTypeFilter>(["memory", "ticket", "thread"]);

export interface ParsedQuery {
  query: string; // query with node:/type: tokens removed
  node: string | null;
  type: SearchTypeFilter | null;
  channel?: string;
  recent?: boolean;
}

// `node:` values are graph node ids which contain colons AND, for endpoints, a
// single space between the HTTP method and the path ('api:dashboard:GET
// /agents'). A naive whitespace split severs that id. So on hitting `node:` we
// absorb ONE following token into the id when it's a path continuation — the
// last part is an HTTP method OR the next token starts with '/'. Everything else
// (real keywords like 'hmac') stays a keyword. `type:` is a plain leading token
// that also ends node absorption. This matches the "+N more" line the headline
// emits: `search_knowledge node:<id> type:<t>`.
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export function parseSearchTokens(raw: string): ParsedQuery {
  let node: string | null = null;
  let type: SearchTypeFilter | null = null;
  let channel: string | undefined;
  let recent: boolean | undefined;
  const kept: string[] = [];
  const toks = raw.split(/\s+/).filter(Boolean);
  const isTypeTok = (t: string) =>
    t.startsWith("type:") && TYPE_FILTERS.has(t.slice(5).toLowerCase() as SearchTypeFilter);

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.startsWith("channel:") && tok.length > 8) {
      channel = tok.slice(8).replace(/^<#([^>|]+)(?:\|[^>]+)?>$/, "$1");
      continue;
    }
    if (tok === "sort:recent") {
      recent = true;
      continue;
    }
    if (node === null && tok.startsWith("node:") && tok.length > 5) {
      const parts = [tok.slice(5)];
      // Absorb a path continuation for endpoint ids: '<...>:GET' + '/agents'.
      while (
        i + 1 < toks.length &&
        !isTypeTok(toks[i + 1]) &&
        !/^(channel:|sort:)/.test(toks[i + 1])
      ) {
        const next = toks[i + 1];
        const last = parts[parts.length - 1];
        const lastSeg = last.slice(last.lastIndexOf(":") + 1);
        const continues = next.startsWith("/") || HTTP_METHODS.has(lastSeg);
        if (!continues) break;
        parts.push(toks[++i]);
      }
      node = parts.join(" ");
      continue;
    }
    if (isTypeTok(tok)) {
      type = tok.slice(5).toLowerCase() as SearchTypeFilter;
      continue;
    }
    kept.push(tok);
  }
  return {
    query: kept.join(" ").trim(),
    node,
    type,
    ...(channel ? { channel } : {}),
    ...(recent ? { recent } : {}),
  };
}

// Filler words a keyword search must ignore. The point (per the grep analogy):
// a model searching memory keys on meaningful strings, not whole sentences — so
// a natural-language query like "…images ON a landing page" must NOT match a
// memory merely because both contain "on". Without this, common-token FTS hits
// bypass the silence gate and every query returns noise. This is NOT about
// negation — "not"/"no" are dropped here because FTS never carries meaning;
// the agent reads the claim text to see whether a memory says always vs never.
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "get",
  "gets",
  "got",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "over",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "you",
  "your",
  "about",
  "all",
  "any",
  "just",
  "like",
  "some",
  "such",
  "via",
  "using",
  "use",
  "should",
]);

// Meaningful search tokens, grep-style: keep identifiers/paths/error snippets
// (anything with a code char) at any length; keep plain words that aren't filler;
// drop everything else. Lowercased for matching.
export function meaningfulTokens(query: string): string[] {
  const raw = query.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const out: string[] = [];
  for (const t of raw) {
    const lower = t.toLowerCase();
    const hasCodeChar = /[_./:-]/.test(t) || /\d/.test(t);
    if (hasCodeChar) {
      out.push(lower);
      continue;
    }
    if (lower.length >= 2 && !STOPWORDS.has(lower)) out.push(lower);
  }
  return out;
}

// corpus-observe.ts — enrich the corpus_insert path so slack/linear rows also
// become observations (embedded, searchable via search_knowledge alongside session
// memories). repo_family is inferred from a channel/ticket→repo mapping when one
// exists; otherwise null, which the cross-family gate treats as match-all.
//
// Corpus observations are NOT consolidated into memories (they're evidence, not
// distilled claims) — they live in the observations table with memory_id NULL
// and surface through FTS + vector search directly.

import { getObservationBySource, insertObservation, refreshObservation } from "./store.js";
import { getSetting } from "../settings.js";

// Optional mapping: JSON in setting CORPUS_REPO_MAP, e.g.
//   { "channels": {"C123":"acme-backend"}, "tickets": {"ACME":"acme-web"} }
interface RepoMap {
  channels?: Record<string, string>;
  tickets?: Record<string, string>;
}

function repoMap(): RepoMap {
  const raw = getSetting("CORPUS_REPO_MAP");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RepoMap;
  } catch {
    return {};
  }
}

export function repoForChannel(channel: string | null | undefined): string | null {
  if (!channel) return null;
  return repoMap().channels?.[channel] ?? null;
}

// Linear identifiers are "ACME-123" — the team prefix is the mapping key.
export function repoForTicket(identifier: string | null | undefined): string | null {
  if (!identifier) return null;
  const prefix = identifier.split("-")[0];
  return repoMap().tickets?.[prefix] ?? null;
}

// Best-effort: never throws, never blocks the corpus insert (callers `void` it).
// source_id/source_url are the citation refs back to the original artifact
// (slack event id + permalink, linear issue id + url). (source, source_id) is
// also the dedupe key: re-mirrored sources (a linear ticket updates on every
// poll) refresh their one observation instead of accumulating duplicates.
export async function observeCorpus(o: {
  source: "slack" | "linear" | "meeting";
  text: string;
  repo?: string | null;
  source_id?: string | null;
  source_url?: string | null;
}): Promise<void> {
  const text = o.text.trim();
  if (!text) return;
  const claim = text.slice(0, 1000);
  try {
    if (o.source_id) {
      const existing = getObservationBySource(o.source, o.source_id);
      if (existing) {
        if (existing.claim === claim && existing.source_url === (o.source_url ?? null)) return;
        await refreshObservation(existing.id, { claim, source_url: o.source_url ?? null });
        return;
      }
    }
    await insertObservation({
      source: o.source,
      repo: o.repo ?? null,
      source_id: o.source_id ?? null,
      source_url: o.source_url ?? null,
      claim,
      kind: "gotcha", // corpus rows carry no distilled kind; a neutral bucket
      source_weight: "user_stated", // a human said it in slack/linear
      retrieval_keys: [],
    });
  } catch (err) {
    console.warn(`[memory] corpus observe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// adapters/fireflies.ts — Fireflies.ai transcript polling adapter.
//
// Real API shape (implement when FIREFLIES_API_KEY is available):
//   Endpoint: POST https://api.fireflies.ai/graphql
//   Auth: Authorization: Bearer <FIREFLIES_API_KEY>
//   Query:
//     query GetTranscripts($date_gte: DateTime) {
//       transcripts(date_gte: $date_gte) {
//         id
//         title
//         date
//         duration
//         participants
//         sentences {
//           speaker_name
//           text
//           start_time   # milliseconds
//           end_time     # milliseconds
//         }
//       }
//     }
//
// Cursor is an ISO timestamp string (date of last seen transcript).
// On first run (cursor === "") we default to 30 days back.
//
// MOCK mode: set FLOW_FIREFLIES_MOCK=<path-to-json> to load transcripts from
// a JSON file rather than calling the real API. The JSON file must be an
// array of FirefliesTranscript objects (same shape as the GraphQL response).
// This is how tests exercise the poller without a real API key.
//
// Webhook accelerator note:
//   Fireflies does not have a standard incoming webhook; polling is the only
//   mechanism. When/if Fireflies adds webhook support, the handler should call
//   triggerFirefliesPoll() below to do an immediate out-of-band fetch.
//
// Poller registration:
//   Call startFirefliesPoller() from index.ts boot section when
//   FIREFLIES_API_KEY (or FLOW_FIREFLIES_MOCK) is present AND
//   FLOW_POLL_DISABLE !== "1".

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLogger } from "@flow/logger";
import { registerPoller, stopPoller } from "../poller.js";
import type { NormalizedEvent } from "../events.js";

const log = createLogger("fireflies");

// ------------------------------------------------------------------
// Fireflies API types
// ------------------------------------------------------------------

export interface FirefliesSentence {
  speaker_name: string;
  text: string;
  start_time: number; // milliseconds from transcript start
  end_time: number;   // milliseconds from transcript start
}

export interface FirefliesTranscript {
  id: string;
  title: string;
  date: string;       // ISO timestamp of when the meeting happened
  duration?: number;  // total duration in seconds
  participants?: string[];
  sentences: FirefliesSentence[];
}

// ------------------------------------------------------------------
// Fetch transcripts since cursor (real API path)
// ------------------------------------------------------------------

const FIREFLIES_API = "https://api.fireflies.ai/graphql";

const TRANSCRIPTS_QUERY = `
  query GetTranscripts($date_gte: DateTime) {
    transcripts(date_gte: $date_gte) {
      id
      title
      date
      duration
      participants
      sentences {
        speaker_name
        text
        start_time
        end_time
      }
    }
  }
`;

async function fetchTranscriptsSince(cursor: string): Promise<{
  transcripts: FirefliesTranscript[];
  nextCursor: string;
}> {
  const mockPath = process.env.FLOW_FIREFLIES_MOCK;

  if (mockPath) {
    // Mock mode: load from JSON file, filter by date if cursor set
    const raw = readFileSync(mockPath, "utf-8");
    const all = JSON.parse(raw) as FirefliesTranscript[];
    const since = cursor ? new Date(cursor).getTime() : 0;
    const filtered = cursor
      ? all.filter((t) => new Date(t.date).getTime() > since)
      : all;
    // Sort ascending so cursor advances correctly
    filtered.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const nextCursor =
      filtered.length > 0
        ? filtered[filtered.length - 1].date
        : cursor || new Date(0).toISOString();
    return { transcripts: filtered, nextCursor };
  }

  // Real API path
  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) throw new Error("FIREFLIES_API_KEY not set");

  // Default cursor: 30 days back on first run
  const dateGte = cursor || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(FIREFLIES_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: TRANSCRIPTS_QUERY,
      variables: { date_gte: dateGte },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fireflies API HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    data?: { transcripts: FirefliesTranscript[] };
    errors?: Array<{ message: string }>;
  };

  if (json.errors && json.errors.length > 0) {
    throw new Error(`Fireflies GQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const transcripts = json.data?.transcripts ?? [];
  // Sort ascending
  transcripts.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const nextCursor =
    transcripts.length > 0
      ? transcripts[transcripts.length - 1].date
      : dateGte;

  return { transcripts, nextCursor };
}

// ------------------------------------------------------------------
// fetchSince adapter — maps FirefliesTranscript[] to {items, nextCursor}
// where each "item" is a FirefliesTranscript (toEvent maps it).
// ------------------------------------------------------------------

export async function firefliesFetchSince(cursor: string): Promise<{
  items: FirefliesTranscript[];
  nextCursor: string;
}> {
  const { transcripts, nextCursor } = await fetchTranscriptsSince(cursor);
  return { items: transcripts, nextCursor };
}

// ------------------------------------------------------------------
// toEvent — converts a FirefliesTranscript to a NormalizedEvent.
// Each transcript becomes a single meeting event; the meeting upload
// pipeline (meetings.ts) handles segmentation downstream when the
// event is processed. Here we embed the full transcript text as a
// single payload so the event can be routed + classified normally.
// ------------------------------------------------------------------

export function firefliesToEvent(transcript: FirefliesTranscript): NormalizedEvent {
  // Reassemble sentences into a single transcript string for the
  // meeting pipeline to segment. Format: "Speaker: text\n..."
  const rawTranscript = transcript.sentences
    .map((s) => `${s.speaker_name}: ${s.text}`)
    .join("\n");

  return {
    id: randomUUID(),
    source: "meeting",
    type: "fireflies_transcript",
    ts: new Date(transcript.date).getTime(),
    payload: {
      transcript_id: transcript.id,
      title: transcript.title,
      date: transcript.date,
      duration: transcript.duration,
      participants: transcript.participants ?? [],
      raw_transcript: rawTranscript,
      sentence_count: transcript.sentences.length,
    },
  };
}

// ------------------------------------------------------------------
// Poller registration
// ------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Start the Fireflies poller.
 * Requires FIREFLIES_API_KEY OR FLOW_FIREFLIES_MOCK to be set.
 * No-ops if FLOW_POLL_DISABLE=1.
 */
export function startFirefliesPoller(intervalMs = DEFAULT_INTERVAL_MS): ReturnType<typeof setInterval> | null {
  const hasKey = !!process.env.FIREFLIES_API_KEY;
  const hasMock = !!process.env.FLOW_FIREFLIES_MOCK;

  if (!hasKey && !hasMock) {
    log.info("FIREFLIES_API_KEY not set and FLOW_FIREFLIES_MOCK not set — poller not started");
    return null;
  }

  return registerPoller<FirefliesTranscript>({
    source: "fireflies",
    resource: "_all",
    intervalMs,
    fetchSince: firefliesFetchSince,
    toEvent: firefliesToEvent,
  });
}

/**
 * Stop the Fireflies poller.
 */
export function stopFirefliesPoller(): void {
  stopPoller("fireflies", "_all");
}

/**
 * Trigger an immediate out-of-band Fireflies poll.
 * TODO: Wire this to a Fireflies webhook if/when Fireflies adds one.
 * Currently a no-op placeholder that documents the intent.
 */
export async function triggerFirefliesPoll(): Promise<void> {
  // Fireflies does not currently provide incoming webhooks.
  // When they do, this function should call registerPoller's pollTick
  // directly (or simply call firefliesFetchSince + processEvent inline).
  log.info("triggerFirefliesPoll called — no-op (Fireflies has no webhooks)");
}

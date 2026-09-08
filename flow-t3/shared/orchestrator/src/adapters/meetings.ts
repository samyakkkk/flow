// adapters/meetings.ts — Meeting transcript ingest + Fireflies poller.
//
// POST /v1/meetings/upload {title, date, transcript} →
//   1. Segment transcript on speaker turns (e.g. "Speaker: text" lines)
//   2. Insert each segment into meeting_segments corpus
//   3. Emit one NormalizedEvent per segment (source: meeting, type: segment)
//      with batch classification by the normal pipeline.
//
// Fireflies poller: registerFirefliesPoller() polls the Fireflies GraphQL API
//   for new transcripts since the last cursor (ISO timestamp).
//   API base URL: FIREFLIES_API_URL env (default https://api.fireflies.ai/graphql)
//   so tests can point it at a local mock server.
//
// GraphQL shape (real Fireflies API):
//   query { transcripts(fromDate: $since) {
//     id title date
//     sentences { speaker_name text start_time end_time }
//   }}
// The poller injects each transcript via the same insertSegment + processEvent
// pipeline as the manual upload route.

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import db from "../db.js";
import { processEvent, containsSecret } from "../events.js";
import type { NormalizedEvent } from "../events.js";
import { registerPoller } from "../pollers/engine.js";
import type { FetchResult } from "../pollers/engine.js";
import { getSetting } from "../settings.js";

// ------------------------------------------------------------------
// Segmenter
// ------------------------------------------------------------------

export interface MeetingSegment {
  id: string;
  meeting_id: string;
  speaker: string;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
}

/**
 * Split a raw transcript into speaker-turn segments.
 *
 * Recognised formats:
 *   "Speaker Name: text..." — simple speaker prefix
 *   "[00:01:23] Speaker Name: text..." — with timestamp
 *   "[00:01:23 → 00:01:45] Speaker Name: text..." — with range
 *
 * Lines that don't match a speaker prefix are appended to the previous segment.
 */
export function segmentTranscript(
  raw: string,
  meetingId: string
): MeetingSegment[] {
  // Matches: optional [timestamp] then Speaker Name: text
  const SPEAKER_RE = /^(?:\[(\d{2}:\d{2}:\d{2})(?:\s*[→\-–>]+\s*(\d{2}:\d{2}:\d{2}))?\]\s*)?([^:\n]+):\s*(.+)/;

  const lines = raw.split("\n");
  const segments: MeetingSegment[] = [];
  let current: MeetingSegment | null = null;

  function hmsToMs(hms: string): number {
    const [h, m, s] = hms.split(":").map(Number);
    return ((h * 3600) + (m * 60) + s) * 1000;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = SPEAKER_RE.exec(trimmed);
    if (match) {
      // Push previous segment
      if (current) segments.push(current);

      const startStr = match[1];
      const endStr = match[2];
      const speaker = match[3].trim();
      const text = match[4].trim();

      current = {
        id: randomUUID(),
        meeting_id: meetingId,
        speaker,
        text,
        start_ms: startStr ? hmsToMs(startStr) : null,
        end_ms: endStr ? hmsToMs(endStr) : null,
      };
    } else if (current) {
      // Continuation line — append to current segment
      current.text += " " + trimmed;
    }
    // else: preamble before first speaker — skip
  }

  if (current) segments.push(current);
  return segments;
}

// ------------------------------------------------------------------
// DB insert for meeting_segments
// ------------------------------------------------------------------

const insertSegment = db.prepare(`
  INSERT OR IGNORE INTO meeting_segments (id, meeting_id, speaker, text, start_ms, end_ms)
  VALUES (@id, @meeting_id, @speaker, @text, @start_ms, @end_ms)
`);

// ------------------------------------------------------------------
// Route registration
// ------------------------------------------------------------------

export interface MeetingUploadBody {
  title: string;
  date?: string;   // ISO date string
  transcript: string;
}

export function registerMeetingRoutes(app: FastifyInstance): void {
  app.post<{ Body: MeetingUploadBody }>(
    "/v1/meetings/upload",
    async (req, reply) => {
      const { title, date, transcript } = req.body as MeetingUploadBody;

      if (!title || !transcript) {
        return reply.code(400).send({ error: "title and transcript are required" });
      }

      const meetingId = randomUUID();
      const meetingTs = date ? new Date(date).getTime() : Date.now();

      // Segment the transcript, then DROP any segment carrying a credential
      // BEFORE it reaches the corpus (P1-F: corpus must never hold secrets).
      const allSegments = segmentTranscript(transcript, meetingId);
      const segments = allSegments.filter((seg) => !containsSecret(seg.text));
      const dropped = allSegments.length - segments.length;
      if (dropped > 0) {
        console.warn(`[meetings] dropped ${dropped} transcript segment(s) containing secrets`);
      }

      if (segments.length === 0) {
        return reply.code(400).send({ error: "Could not segment transcript — no speaker turns found (or all segments were filtered)" });
      }

      // Insert segments into corpus
      const insertMany = db.transaction(() => {
        for (const seg of segments) {
          insertSegment.run(seg);
        }
      });
      insertMany();

      // Emit one NormalizedEvent per segment (feeds classify → action pipeline)
      const eventIds: string[] = [];
      for (const seg of segments) {
        const event: NormalizedEvent = {
          id: randomUUID(),
          source: "meeting",
          type: "segment",
          ts: meetingTs + (seg.start_ms ?? 0),
          payload: {
            meeting_id: meetingId,
            meeting_title: title,
            segment_id: seg.id,
            speaker: seg.speaker,
            text: seg.text,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
          },
        };
        // Fire-and-forget; don't block the response on slow classification
        void processEvent(event).catch((err) =>
          console.error(`[meetings] Error processing segment event: ${err}`)
        );
        eventIds.push(event.id);
      }

      return reply.code(202).send({
        meeting_id: meetingId,
        segments: segments.length,
        event_ids: eventIds,
      });
    }
  );
}

// ------------------------------------------------------------------
// Fireflies GraphQL types
// ------------------------------------------------------------------

export interface FirefliesSentence {
  speaker_name: string;
  text: string;
  /** start time in seconds (Fireflies uses seconds, not ms) */
  start_time: number | null;
  end_time: number | null;
}

export interface FirefliesTranscriptNode {
  id: string;
  title: string;
  /** ISO 8601 date string */
  date: string;
  sentences: FirefliesSentence[];
}

interface FirefliesGqlResponse {
  data?: { transcripts: FirefliesTranscriptNode[] };
  errors?: Array<{ message: string }>;
}

// ------------------------------------------------------------------
// Fireflies API helper
// ------------------------------------------------------------------

function firefliesApiUrl(): string {
  return process.env.FIREFLIES_API_URL ?? "https://api.fireflies.ai/graphql";
}

/**
 * Ingest a single Fireflies transcript node into the corpus + event pipeline.
 * Returns the number of segments inserted.
 */
async function ingestFirefliesNode(node: FirefliesTranscriptNode): Promise<number> {
  const meetingId = node.id;
  const meetingTs = node.date ? new Date(node.date).getTime() : Date.now();

  // Map Fireflies sentences → MeetingSegment[]
  const allSegments: MeetingSegment[] = node.sentences
    .filter((s) => s.speaker_name && s.text)
    .map((s) => ({
      id: randomUUID(),
      meeting_id: meetingId,
      speaker: s.speaker_name,
      text: s.text,
      start_ms: s.start_time !== null ? Math.round(s.start_time * 1000) : null,
      end_ms: s.end_time !== null ? Math.round(s.end_time * 1000) : null,
    }));

  // Drop segments containing secrets
  const segments = allSegments.filter((seg) => !containsSecret(seg.text));
  const dropped = allSegments.length - segments.length;
  if (dropped > 0) {
    console.warn(`[fireflies] dropped ${dropped} segment(s) with secrets in meeting ${meetingId}`);
  }

  if (segments.length === 0) return 0;

  // Insert into corpus
  const insertMany = db.transaction(() => {
    for (const seg of segments) {
      insertSegment.run(seg);
    }
  });
  insertMany();

  // Emit events into the pipeline
  for (const seg of segments) {
    const event: NormalizedEvent = {
      id: randomUUID(),
      source: "meeting",
      type: "segment",
      ts: meetingTs + (seg.start_ms ?? 0),
      payload: {
        meeting_id: meetingId,
        meeting_title: node.title,
        segment_id: seg.id,
        speaker: seg.speaker,
        text: seg.text,
        start_ms: seg.start_ms,
        end_ms: seg.end_ms,
        source_adapter: "fireflies",
      },
    };
    void processEvent(event).catch((err) =>
      console.error(`[fireflies] processEvent error for segment ${seg.id}: ${err}`)
    );
  }

  return segments.length;
}

// ------------------------------------------------------------------
// Fireflies poller: fetchSince implementation
//
// Cursor shape: ISO timestamp string of the last-seen transcript date.
// On first boot cursor is "" → fetch last 30 days.
//
// Real Fireflies GraphQL query:
//   query($fromDate: String!) {
//     transcripts(fromDate: $fromDate) {
//       id title date
//       sentences { speaker_name text start_time end_time }
//     }
//   }
//
// FIREFLIES_API_URL env lets tests point at a mock server.
// ------------------------------------------------------------------

async function firefliesFetchSince(cursor: string): Promise<FetchResult> {
  const apiKey = getSetting("FIREFLIES_API_KEY") ?? process.env.FIREFLIES_API_KEY;
  if (!apiKey) throw new Error("FIREFLIES_API_KEY not set");

  const fromDate: string = cursor || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(firefliesApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: `query PollTranscripts($fromDate: String!) {
        transcripts(fromDate: $fromDate) {
          id
          title
          date
          sentences {
            speaker_name
            text
            start_time
            end_time
          }
        }
      }`,
      variables: { fromDate },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fireflies API HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as FirefliesGqlResponse;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`Fireflies GQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const transcripts = json.data?.transcripts ?? [];
  let latestDate = cursor;

  for (const node of transcripts) {
    await ingestFirefliesNode(node);
    if (node.date && (!latestDate || node.date > latestDate)) {
      latestDate = node.date;
    }
  }

  // Events are emitted directly inside ingestFirefliesNode; return empty events
  // array here because processEvent was called fire-and-forget above.
  return {
    events: [],
    nextCursor: latestDate || fromDate,
  };
}

export function registerFirefliesPoller(): void {
  const intervalMs = parseInt(
    getSetting("FLOW_FIREFLIES_POLL_MS") ?? process.env.FLOW_FIREFLIES_POLL_MS ?? "300000",
    10
  );

  registerPoller({
    source: "fireflies",
    intervalMs,
    fetchSince: firefliesFetchSince,
    enabled(): boolean {
      const key = getSetting("FIREFLIES_API_KEY") ?? process.env.FIREFLIES_API_KEY ?? "";
      return Boolean(key) && process.env.FLOW_FIREFLIES_POLL_DISABLE !== "1";
    },
  });
}

// ------------------------------------------------------------------
// Legacy one-shot helper (kept for backwards compat / manual testing)
// ------------------------------------------------------------------

export interface FirefliesTranscript {
  title: string;
  date: string;
  participants: string[];
  transcript: string;  // same raw text format
}

/**
 * Fetch and ingest a single transcript from Fireflies by ID.
 * Uses FIREFLIES_API_URL so tests can point at a mock.
 *
 * Real Fireflies GraphQL shape:
 *   query($id: String!) {
 *     transcript(id: $id) {
 *       id title date
 *       sentences { speaker_name text start_time end_time }
 *     }
 *   }
 */
export async function ingestFromFireflies(
  transcriptId: string
): Promise<{ segments: number; meeting_id: string } | null> {
  const apiKey = getSetting("FIREFLIES_API_KEY") ?? process.env.FIREFLIES_API_KEY;
  if (!apiKey) {
    console.warn("[meetings/fireflies] FIREFLIES_API_KEY not set — returning null");
    return null;
  }

  const res = await fetch(firefliesApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: `query($id: String!) {
        transcript(id: $id) {
          id title date
          sentences { speaker_name text start_time end_time }
        }
      }`,
      variables: { id: transcriptId },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fireflies API HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data?: { transcript: FirefliesTranscriptNode }; errors?: Array<{ message: string }> };

  if (json.errors && json.errors.length > 0) {
    throw new Error(`Fireflies GQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const node = json.data?.transcript;
  if (!node) throw new Error(`Fireflies: transcript ${transcriptId} not found`);

  const segments = await ingestFirefliesNode(node);
  return { segments, meeting_id: node.id };
}

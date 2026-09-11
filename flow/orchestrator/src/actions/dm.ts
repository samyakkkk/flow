// dm.ts — DM-the-controller path for propose mode and low-confidence questions.
// Wraps slack.ts dmController with structured propose-mode payload.

import db from "../db.js";
import { dmController } from "./slack.js";
import type { NormalizedEvent } from "../events.js";
import type { ClassificationResult } from "../classify.js";

export async function proposeAction(
  event: NormalizedEvent,
  classification: ClassificationResult,
  proposedAction: string
): Promise<{ outbox_id: number }> {
  const text = [
    `*Flow propose:* \`${event.source}.${classification.classification}\` (confidence ${(classification.confidence * 100).toFixed(0)}%)`,
    `Proposed action: *${proposedAction}*`,
    `Event: \`${event.id}\``,
    classification.extracted && Object.keys(classification.extracted).length > 0
      ? `Extracted: \`\`\`${JSON.stringify(classification.extracted, null, 2)}\`\`\``
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return dmController(text, event.id);
}

export async function lowConfidenceDM(
  event: NormalizedEvent,
  classification: ClassificationResult,
  answer: string
): Promise<{ outbox_id: number }> {
  const text = [
    `*Flow low-confidence answer* (${(classification.confidence * 100).toFixed(0)}% confidence):`,
    answer.slice(0, 500),
    `Event: \`${event.id}\``,
  ].join("\n");

  return dmController(text, event.id);
}

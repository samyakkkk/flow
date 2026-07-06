// classify.ts — Per-source LLM taxonomy classification.
// In test mode (FLOW_TEST_LIVE unset) replays fixtures; live mode records new ones.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedEvent } from "./events.js";
import { getSetting } from "./settings.js";
import { logLLM } from "./llmlog.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../test/fixtures/classifications");

// ------------------------------------------------------------------
// Output contract (system.md)
// ------------------------------------------------------------------

export interface ClassificationResult {
  classification: string;
  confidence: number;      // 0–1
  extracted: Record<string, unknown>;
}

// ------------------------------------------------------------------
// Per-source taxonomy (exact enums from system.md routing table)
// ------------------------------------------------------------------

const TAXONOMIES: Record<string, string[]> = {
  slack_ambient: [
    "noise",
    "knowledge_claim",
    "correction",
    "task_discussion",
    "ticket_status_signal",
    "question_about_system",
    "sensitive",
  ],
  slack_mention: ["question", "command", "feedback"],
  github_merge: ["skip", "index_worthy"],
  linear_ticket: ["needs_context", "duplicate_candidate", "unresolvable", "not_applicable"],
  meeting_segment: ["decision", "action_item", "knowledge_claim", "open_question", "noise"],
};

function taxonomyKey(event: NormalizedEvent): string {
  // Combine source + type to pick taxonomy; e.g. slack+ambient → slack_ambient
  if (event.source === "slack") {
    return event.type === "mention" ? "slack_mention" : "slack_ambient";
  }
  if (event.source === "github") return "github_merge";
  if (event.source === "linear") return "linear_ticket";
  if (event.source === "meeting") return "meeting_segment";
  return "slack_ambient"; // fallback
}

function inputHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function fixtureKey(event: NormalizedEvent): string {
  const text = JSON.stringify({ source: event.source, type: event.type, payload: event.payload });
  return inputHash(text);
}

// ------------------------------------------------------------------
// Classifier interface — swap live vs fixture
// ------------------------------------------------------------------

export interface Classifier {
  classify(event: NormalizedEvent): Promise<ClassificationResult>;
}

class FixtureClassifier implements Classifier {
  async classify(event: NormalizedEvent): Promise<ClassificationResult> {
    const key = fixtureKey(event);
    const path = resolve(FIXTURES_DIR, `${key}.json`);

    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      return JSON.parse(raw) as ClassificationResult;
    }

    // No fixture → return a default "noise" / first-enum classification so tests don't crash
    const taxKey = taxonomyKey(event);
    const enums = TAXONOMIES[taxKey] ?? ["noise"];
    return { classification: enums[0], confidence: 0.5, extracted: {} };
  }
}

class LiveClassifier implements Classifier {
  async classify(event: NormalizedEvent): Promise<ClassificationResult> {
    // Read at call time (not module load) so DB/env changes take effect immediately
    const apiKey = getSetting("OPENROUTER_API_KEY") ?? process.env.OPENROUTER_API_KEY ?? "";
    const model = getSetting("CLASSIFIER_MODEL") ?? process.env.CLASSIFIER_MODEL ?? "minimax/minimax-m3";

    const taxKey = taxonomyKey(event);
    const enums = TAXONOMIES[taxKey] ?? ["noise"];

    if (!apiKey) {
      // No key yet (fresh project): degrade without calling the API. confidence
      // 0 keeps any auto action behind the floor; the reason lands in the audit
      // trail and the dashboard nudges the user to add the key in Settings.
      console.warn("[classify] OPENROUTER_API_KEY not configured — events cannot be understood until it is set (Settings).");
      return {
        classification: enums[0],
        confidence: 0,
        extracted: { unconfigured: "OPENROUTER_API_KEY missing — add it in dashboard Settings" },
      };
    }
    const enumList = enums.map((e) => `"${e}"`).join(" | ");

    const systemPrompt = `You are a classifier for the Flow knowledge agent.
Classify the event into EXACTLY one of: ${enumList}.
Return strict JSON: { "classification": "<one of the enum values>", "confidence": <0.0-1.0>, "extracted": {} }.
Do not add extra fields or prose.`;

    const userPrompt = `Source: ${event.source}\nType: ${event.type}\nPayload: ${JSON.stringify(event.payload)}`;

    const result = await this.callWithRetry(apiKey, model, systemPrompt, userPrompt, enums, event.id);

    // Fixture recording is a test-authoring aid — opt-in only. Production must
    // not write into the source tree.
    if (process.env.FLOW_TEST_LIVE) {
      const key = fixtureKey(event);
      const path = resolve(FIXTURES_DIR, `${key}.json`);
      mkdirSync(FIXTURES_DIR, { recursive: true });
      writeFileSync(path, JSON.stringify(result, null, 2));
    }

    return result;
  }

  private async callWithRetry(
    apiKey: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    enums: string[],
    ref?: string,
    attempts = 3
  ): Promise<ClassificationResult> {
    for (let i = 0; i < attempts; i++) {
      const t0 = Date.now();
      let rawContent = "";
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0,
            response_format: { type: "json_object" },
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenRouter HTTP ${response.status}: ${await response.text()}`);
        }

        const data = await response.json() as {
          choices: Array<{ message: { content: string } }>;
        };

        const content = data.choices[0]?.message?.content;
        if (!content) throw new Error("Empty classifier response");
        rawContent = content;

        const parsed = JSON.parse(content) as ClassificationResult;

        // Validate enum membership
        if (!enums.includes(parsed.classification)) {
          throw new Error(`Invalid classification "${parsed.classification}" not in [${enums.join(", ")}]`);
        }

        logLLM({
          kind: "classifier", ref, model, attempt: i + 1, ok: true,
          latencyMs: Date.now() - t0,
          prompt: `${systemPrompt}\n---\n${userPrompt}`,
          response: content,
        });
        return parsed;
      } catch (err) {
        logLLM({
          kind: "classifier", ref, model, attempt: i + 1, ok: false,
          latencyMs: Date.now() - t0,
          error: (err as Error).message,
          prompt: `${systemPrompt}\n---\n${userPrompt}`,
          response: rawContent || undefined,
        });
        if (i === attempts - 1) throw err;
        // Retry on parse or network error
        console.warn(`[classify] attempt ${i + 1} failed, retrying: ${(err as Error).message}`);
      }
    }
    throw new Error("Classifier: exhausted retries");
  }
}

// ------------------------------------------------------------------
// Module-level singleton — can be overridden in tests
// ------------------------------------------------------------------

// LIVE is the production default. Fixture replay is a TEST harness and runs
// only when tests opt in (FLOW_FAKE_OPENCODE=1, which every test suite and the
// simulators set) or when explicitly forced with FLOW_CLASSIFIER=fixture.
// (Previously fixture was the default behind the misnamed FLOW_TEST_LIVE flag,
// which made real deployments classify everything as low-confidence noise.)
const useFixtures =
  process.env.FLOW_CLASSIFIER === "fixture" ||
  (!!process.env.FLOW_FAKE_OPENCODE && !process.env.FLOW_TEST_LIVE);

let _classifier: Classifier = useFixtures ? new FixtureClassifier() : new LiveClassifier();

export function setClassifier(c: Classifier): void {
  _classifier = c;
}

export async function classify(event: NormalizedEvent): Promise<ClassificationResult> {
  return _classifier.classify(event);
}

export { TAXONOMIES, taxonomyKey, fixtureKey, inputHash, FIXTURES_DIR, FixtureClassifier, LiveClassifier };

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { originalBrainTools } from "./session-worker.ts";
it.effect(
  "discovers the original Flow session tools with their full schemas and write annotations",
  () =>
    Effect.gen(function* () {
      const tools = yield* Effect.promise(originalBrainTools);
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "correct_graph",
        "find_entity",
        "get_entity",
        "list_schema",
        "orient",
        "read_query",
        "remember",
        "search_knowledge",
        "source_read",
        "source_search",
      ]);
      expect(tools.find((tool) => tool.name === "remember")?.annotations?.readOnlyHint).toBe(false);
      expect(tools.find((tool) => tool.name === "source_read")?.inputSchema).toMatchObject({
        properties: { revision: { type: "string" } },
      });
      expect(tools.find((tool) => tool.name === "find_entity")?.inputSchema).toMatchObject({
        properties: { qs: { type: "array" } },
      });
    }),
);

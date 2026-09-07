import { describe, expect, it } from "vite-plus/test";
import { sampleBrainRepository } from "./sampleData";
import { searchMemories } from "./repository";

describe("sample brain queries", () => {
  it("keeps workspace memories isolated and rejects unknown workspaces", () => {
    const flow = sampleBrainRepository.read("sample-flow");
    const checkout = sampleBrainRepository.read("sample-checkout");
    expect(searchMemories(flow, "payment", "All")).toEqual([]);
    expect(searchMemories(checkout, "payment", "All").length).toBeGreaterThan(0);
    expect(() => sampleBrainRepository.read("live-flow")).toThrow("Unknown sample workspace");
  });
  it("combines case-insensitive terms with category filters and searches evidence", () => {
    const flow = sampleBrainRepository.read("sample-flow");
    expect(searchMemories(flow, "  MODEL   workspace ", "Gotcha").map((m) => m.id)).toEqual(["m4"]);
    expect(searchMemories(flow, "model", "Preference")).toEqual([]);
    expect(searchMemories(flow, "Resource ownership", "All").map((m) => m.id)).toEqual(["m4"]);
    expect(searchMemories(flow, "   ", "All")).toHaveLength(flow.memories.length);
  });
});

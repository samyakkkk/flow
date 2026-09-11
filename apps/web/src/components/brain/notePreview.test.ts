import { describe, expect, it } from "vite-plus/test";
import { notePreview } from "./notePreview";

describe("conversation note preview", () => {
  it("prioritizes explicit next steps and keeps qualifications", () => {
    const result = notePreview("# Migration\n## Continue this work\nGoal: improve notes\nCompleted: code written, not verified\nNext action: wait for approval before deployment\n## Work log\n### L1 — Old work\nDo not show this in the preview");
    expect(result?.title).toBe("Migration");
    expect(result?.sections[0]).toEqual({label:"Next action",text:"wait for approval before deployment"});
    expect(result?.sections.some(s => s.text.includes("not verified"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Do not show");
  });
  it("accepts bold bullet labels and multiline tasks", () => {
    expect(notePreview("## Continue this work\r\n- **Next steps:**\r\n  - Inspect\r\n  - Test")?.sections[0]).toEqual({label:"Next steps",text:"\n- Inspect\n- Test"});
  });
  it("does not invent tasks from unlabelled prose", () => {
    expect(notePreview("## Continue this work\nWork is complete. No follow-up requested.")?.sections).toEqual([{label:"Current state",text:"Work is complete. No follow-up requested."}]);
  });
  it("falls back for legacy, empty and fenced content", () => {
    for (const text of ["Old prose", "## Continue this work\n## Work log", "```md\n## Continue this work\nExample\n```", ""])
      expect(notePreview(text)).toBeNull();
  });
});

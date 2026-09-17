import { expect, it } from "vite-plus/test";
import { chooseNotesCli, classifyAgentIssue, cliFromExecutable } from "./agent-issue.ts";

it("recognises a signed-out agent and names it", () => {
  const issue = classifyAgentIssue("Invalid API key · Please run /login", "claude", "Notes");
  expect(issue?.kind).toBe("signedOut");
  expect(issue?.message).toBe(
    "Notes are paused: Claude Code is signed out on this computer. Sign in to Claude Code, or choose another agent in Brain settings.",
  );
});
it("treats a 429 with authorization wording as a usage limit, not a sign-out", () => {
  const issue = classifyAgentIssue(
    "429 Too Many Requests: authorization ok, usage limit reached, try again at 5pm",
    "codex",
    "Indexing",
  );
  expect(issue?.kind).toBe("usageLimit");
  expect(issue?.message).toContain("Indexing is paused: Codex reached its usage limit");
});
it("recognises a missing agent", () => {
  expect(classifyAgentIssue("spawn opencode ENOENT", "opencode", "Indexing")?.kind).toBe(
    "unavailable",
  );
  expect(
    classifyAgentIssue("Enable a claude provider to extract this Brain's notes", "claude", "Notes")
      ?.kind,
  ).toBe("unavailable");
});
it("leaves unrelated failures unclassified and never echoes provider text", () => {
  expect(
    classifyAgentIssue("The extraction host disconnected.", "claude", "Notes"),
  ).toBeUndefined();
  expect(classifyAgentIssue(null, "claude", "Notes")).toBeUndefined();
  const secret = "sk-live-abc not logged in";
  expect(classifyAgentIssue(secret, "claude", "Notes")?.message).not.toContain("sk-live");
});
it("maps executables to agents", () => {
  expect(cliFromExecutable("/opt/homebrew/bin/claude")).toBe("claude");
  expect(cliFromExecutable("C:\\tools\\codex.exe")).toBe("codex");
  expect(cliFromExecutable("/usr/bin/node")).toBeUndefined();
});
it("writes a cloud Brain's notes with the agent the user chose, not the machine default", () => {
  const base = { remote: true, installed: ["claude", "codex"], machineDefault: "codex" } as const;
  expect(chooseNotesCli({ ...base, chosen: "claude" })).toBe("claude");
  // The choice only yields when that agent is not installed here.
  expect(chooseNotesCli({ ...base, chosen: "opencode" })).toBe("codex");
  expect(chooseNotesCli({ ...base, chosen: "opencode", machineDefault: undefined })).toBe("claude");
  // A local Brain always uses its own agent.
  expect(chooseNotesCli({ ...base, remote: false, chosen: "opencode" })).toBe("opencode");
});

import { describe, expect, it } from "vite-plus/test";
import { codexSubscriptionIssue } from "./curator.ts";

describe("subscription-backed curation", () => {
  it("requires a ChatGPT account rather than API-key or anonymous access", () => {
    for (const account of [null, { type: "apiKey" }, { type: "amazonBedrock" }])
      expect(codexSubscriptionIssue({ account }, {})).toMatch(/Sign.*ChatGPT/);
    expect(
      codexSubscriptionIssue(
        { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
        { model_provider: "openai" },
      ),
    ).toBeUndefined();
    expect(codexSubscriptionIssue({ account: { type: "chatgpt" } }, {})).toBeUndefined();
  });

  it("does not mistake a stored ChatGPT login for subscription use on a custom backend", () => {
    const account = { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
    expect(codexSubscriptionIssue(account, { model_provider: "custom-api" })).toMatch(
      /custom model backend/,
    );
    expect(codexSubscriptionIssue({ ...account, requiresOpenaiAuth: false }, {})).toMatch(
      /custom model backend/,
    );
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@t3tools/shared/branding", async (importOriginal) => {
  const original = await importOriginal<typeof import("@t3tools/shared/branding")>();
  return {
    ...original,
    BRAND: { ...original.BRAND, name: "Acme & <Engineering>", connectName: "Acme <Connect>" },
  };
});

import { renderLoopbackAuthorizationCompleteHtml } from "./cliAuthHtml.ts";

describe("authorization page branding", () => {
  it.each(["dev", "nightly", "latest"] as const)(
    "escapes enterprise names in the %s page",
    (stage) => {
      const html = renderLoopbackAuthorizationCompleteHtml(stage);
      expect(html).toContain("Acme &amp; &lt;Engineering&gt;");
      expect(html).toContain("Acme &lt;Connect&gt; authorization complete");
      expect(html).not.toContain("Acme & <Engineering>");
    },
  );
});

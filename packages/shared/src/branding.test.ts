import { describe, expect, it } from "vite-plus/test";
import { BRAND, escapeBrandHtml } from "./branding.ts";

describe("branding", () => {
  it("escapes enterprise names for HTML and installer XML", () => {
    expect(escapeBrandHtml('Acme & Partners <Engineering> "Tools"')).toBe(
      "Acme &amp; Partners &lt;Engineering&gt; &quot;Tools&quot;",
    );
  });

  it("provides the default deployment name", () => {
    expect(BRAND.name).toBe("Flow");
  });
});

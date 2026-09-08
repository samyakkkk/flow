import { describe, expect, it } from "vite-plus/test";
import defaults from "../../branding.json" with { type: "json" };
import { mergeBranding, renderBrandSvg, validateBranding } from "./branding-config.ts";

describe("deployment branding", () => {
  it("merges an enterprise override without losing unspecified logo or link settings", () => {
    const brand = mergeBranding(defaults, {
      name: "Acme & Partners",
      shortName: "Acme",
      connectName: "Acme Connect",
      links: { support: "https://acme.example/help" },
      colors: { background: "#123456" },
    });
    expect(brand.name).toBe("Acme & Partners");
    expect(brand.links.support).toBe("https://acme.example/help");
    expect(brand.links.releases).toBe(defaults.links.releases);
    expect(brand.mark).toEqual(defaults.mark);
    expect(renderBrandSvg(brand)).toContain('fill="#123456"');
  });

  it.each([
    { name: "" },
    { name: "Acme\nInjected" },
    { unknownField: "Acme" },
    { colors: { background: "red" } },
    { mark: { path: '<image href="https://example.com" />' } },
    { mark: { viewBox: "0 0 0 24" } },
    { links: { support: "javascript:alert(1)" } },
    { links: null },
  ])("rejects malformed overrides before generating deployment assets: %j", (override) => {
    expect(() => mergeBranding(defaults, override)).toThrow();
  });

  it("keeps transparent marks free of the app icon background", () => {
    expect(renderBrandSvg(validateBranding(defaults), { background: false })).not.toContain(
      "<rect",
    );
  });
});

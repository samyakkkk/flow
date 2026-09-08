import config from "../../../branding.json" with { type: "json" };

/** Deployment branding is bundled with every client and server. Rebuild after changing it. */
export const BRAND = config;

/** Use when inserting deployment-controlled text into HTML or XML strings. */
export function escapeBrandHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

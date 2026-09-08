// @effect-diagnostics nodeBuiltinImport:off - Build config hooks run synchronously before an Effect runtime exists.
import * as NodeFS from "node:fs";
import config from "../../branding.json" with { type: "json" };
import { brandingFingerprint, validateBranding } from "./branding-config.ts";

/** Fail before a build can combine one organization's name with another's icons. */
export function checkBranding() {
  const expected = brandingFingerprint(validateBranding(config));
  let actual: string;
  try {
    actual = NodeFS.readFileSync(
      new URL("../../assets/brand/fingerprint", import.meta.url),
      "utf8",
    ).trim();
  } catch {
    throw new Error("Brand assets are missing. Run pnpm branding:generate before building.");
  }
  if (actual !== expected) {
    throw new Error("Brand config changed. Run pnpm branding:generate before building.");
  }
}

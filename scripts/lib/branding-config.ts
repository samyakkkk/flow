import type defaults from "../../branding.json";
type Branding = typeof defaults;

import * as NodeCrypto from "node:crypto";

export function validateBranding(config: unknown): Branding {
  function record(
    value: unknown,
    keys: readonly string[],
    label: string,
  ): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object.`);
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) throw new Error(`Unknown branding field: ${label}.${key}`);
    }
    for (const key of keys) {
      if (!(key in value)) throw new Error(`Missing branding field: ${label}.${key}`);
    }
  }
  record(
    config,
    ["name", "shortName", "connectName", "description", "links", "mark", "colors"],
    "branding",
  );
  for (const key of ["name", "shortName", "connectName", "description"] as const) {
    if (
      typeof config[key] !== "string" ||
      !config[key].trim() ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(config[key])
    ) {
      throw new Error(`branding.${key} must be a nonempty single-line string.`);
    }
  }
  record(
    config.links,
    [
      "website",
      "releases",
      "support",
      "legalWebsite",
      "repository",
      "iosDownload",
      "androidDownload",
    ],
    "links",
  );
  for (const [key, value] of Object.entries(config.links)) {
    if (typeof value !== "string" || !/^https?:\/\//.test(value))
      throw new Error(`links.${key} must be an HTTP(S) URL.`);
    const url = new URL(value);
    if (url.username || url.password) throw new Error(`links.${key} must not contain credentials.`);
  }
  record(config.colors, ["background", "foreground"], "colors");
  for (const value of Object.values(config.colors)) {
    if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value))
      throw new Error("Brand colors must use six-digit hex notation.");
  }
  record(config.mark, ["viewBox", "path"], "mark");
  const viewBox =
    typeof config.mark.viewBox === "string"
      ? config.mark.viewBox.trim().split(/\s+/).map(Number)
      : [];
  if (
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    (viewBox[2] ?? 0) <= 0 ||
    (viewBox[3] ?? 0) <= 0
  ) {
    throw new Error("mark.viewBox must contain four numbers with positive width and height.");
  }
  if (
    typeof config.mark.path !== "string" ||
    !/^[Mm][\d\s.,+eE\-MmZzLlHhVvCcSsQqTtAa]+$/.test(config.mark.path)
  ) {
    throw new Error("mark.path must contain SVG path data.");
  }
  return config as Branding;
}

/** Merge known nested sections so an enterprise override can supply only changed fields. */
export function mergeBranding(base: Branding, overrides: unknown): Branding {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new Error("Branding overrides must be an object.");
  const merged: Record<string, unknown> = { ...base, ...overrides };
  const overrideRecord = overrides as Record<string, unknown>;
  for (const key of ["links", "mark", "colors"] as const) {
    if (key in overrides) {
      if (
        !overrideRecord[key] ||
        typeof overrideRecord[key] !== "object" ||
        Array.isArray(overrideRecord[key])
      )
        throw new Error(`${key} must be an object.`);
      merged[key] = { ...base[key], ...overrideRecord[key] };
    }
  }
  return validateBranding(merged);
}

export function brandingFingerprint(config: Branding) {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderBrandSvg(
  config: Branding,
  { background = true }: { background?: boolean } = {},
) {
  const { mark, colors } = config;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${background ? `<rect width="1024" height="1024" fill="${colors.background}"/>` : ""}<svg x="192" y="192" width="640" height="640" viewBox="${escapeXml(mark.viewBox)}"><path d="${escapeXml(mark.path)}" fill="${colors.foreground}"/></svg></svg>`;
}

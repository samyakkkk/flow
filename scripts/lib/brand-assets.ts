export const BRAND_ASSET_PATHS = {
  developmentIosIconPng: "assets/brand/icon.png",
  developmentUniversalIconPng: "assets/brand/icon.png",

  productionIosIconPng: "assets/brand/icon.png",
  productionMacIconPng: "assets/brand/icon.png",
  productionLinuxIconPng: "assets/brand/icon.png",
  productionWindowsIconIco: "assets/brand/icon.ico",
  productionWebFaviconIco: "assets/brand/favicon.ico",
  productionWebFavicon16Png: "assets/brand/favicon-16x16.png",
  productionWebFavicon32Png: "assets/brand/favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/brand/apple-touch-icon.png",

  nightlyIosIconPng: "assets/brand/icon.png",
  nightlyMacIconPng: "assets/brand/icon.png",
  nightlyLinuxIconPng: "assets/brand/icon.png",
  nightlyWindowsIconIco: "assets/brand/icon.ico",
  nightlyWebFaviconIco: "assets/brand/favicon.ico",
  nightlyWebFavicon16Png: "assets/brand/favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/brand/favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/brand/apple-touch-icon.png",

  developmentDesktopIconPng: "assets/brand/icon.png",
  developmentWindowsIconIco: "assets/brand/icon.ico",
  developmentWebFaviconIco: "assets/brand/favicon.ico",
  developmentWebFavicon16Png: "assets/brand/favicon-16x16.png",
  developmentWebFavicon32Png: "assets/brand/favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/brand/apple-touch-icon.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return version.includes("-nightly.") ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);

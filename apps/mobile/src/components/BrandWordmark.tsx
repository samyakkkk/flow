import { BRAND } from "@t3tools/shared/branding";
import { Image } from "expo-image";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useUniwindTheme } from "../lib/useUniwindTheme";

const WORDMARK_ON_LIGHT_SOURCE = require("../../assets/brand-wordmark-on-light.png");
const WORDMARK_ON_DARK_SOURCE = require("../../assets/brand-wordmark-on-dark.png");
const WORDMARK_ASPECT_RATIO = 886 / 430;

export function BrandWordmark(props: {
  readonly height: number;
  readonly surface?: "auto" | "light" | "dark";
}) {
  const { themeAppearance } = useAppearancePreferences();
  const theme = useUniwindTheme();
  const surface = props.surface ?? "auto";
  const useDarkSurfaceArtwork =
    surface === "dark" || (surface === "auto" && themeAppearance === "dark");

  return (
    <Image
      accessibilityIgnoresInvertColors
      accessibilityLabel={BRAND.name}
      contentFit="contain"
      source={useDarkSurfaceArtwork ? WORDMARK_ON_DARK_SOURCE : WORDMARK_ON_LIGHT_SOURCE}
      style={{
        height: props.height,
        tintColor: useDarkSurfaceArtwork ? undefined : theme["--color-foreground"],
        width: props.height * WORDMARK_ASPECT_RATIO,
      }}
    />
  );
}

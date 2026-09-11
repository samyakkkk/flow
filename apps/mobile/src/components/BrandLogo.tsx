import { BRAND } from "@t3tools/shared/branding";
import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);
const [, , width = 24, height = 24] = BRAND.mark.viewBox.split(/\s+/).map(Number);

export function BrandLogo(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel={BRAND.name}
      height={props.height}
      width={(props.height * width) / height}
      viewBox={BRAND.mark.viewBox}
    >
      <ThemedPath
        d={BRAND.mark.path}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}

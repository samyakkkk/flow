import { BRAND } from "@t3tools/shared/branding";
import type { SVGProps } from "react";

export function BrandLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-label={BRAND.name}
      {...props}
      viewBox={BRAND.mark.viewBox}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={BRAND.mark.path} fill="currentColor" />
    </svg>
  );
}

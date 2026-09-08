import { BRAND } from "@t3tools/shared/branding";
import type { HTMLAttributes } from "react";

import { cn } from "../lib/utils";

export type BrandWordmarkSurface = "auto" | "light" | "dark";

export function BrandWordmark({
  className,
  surface = "auto",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { readonly surface?: BrandWordmarkSurface }) {
  return (
    <span
      aria-label={BRAND.name}
      role="img"
      {...props}
      className={cn("inline-flex shrink-0", className)}
    >
      <span
        aria-hidden
        className={cn(
          "aspect-[443/215] h-full shrink-0 bg-current",
          surface === "dark" ? "hidden" : surface === "auto" ? "block dark:hidden" : "block",
        )}
        style={{
          WebkitMaskImage: 'url("/brand-wordmark-on-light.svg")',
          WebkitMaskPosition: "center",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskSize: "contain",
          maskImage: 'url("/brand-wordmark-on-light.svg")',
          maskPosition: "center",
          maskRepeat: "no-repeat",
          maskSize: "contain",
        }}
      />
      <img
        alt=""
        aria-hidden
        className={cn(
          "h-full w-auto max-w-none",
          surface === "auto" ? "hidden dark:block" : surface === "light" ? "hidden" : "block",
        )}
        src="/brand-wordmark-on-dark.svg"
      />
    </span>
  );
}

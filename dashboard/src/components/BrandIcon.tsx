"use client";
// Brand marks (mostly inline single-color SVGs). Each renders a 24x24 viewBox SVG with
// fill="currentColor" so it inherits the surrounding text color — keeping the
// monochrome editorial look (no brand colors). Path data for github, linear,
// slack, anthropic, openai and opencode is copied verbatim from Simple Icons
// (https://simpleicons.org). Fireflies is not in Simple Icons, so it uses a
// clean spark mark drawn to read as a logo.
import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 20, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

// Source: Simple Icons — github
export function GithubIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </Svg>
  );
}

// Source: Simple Icons — linear
export function LinearIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </Svg>
  );
}

// Source: Simple Icons — slack. The real logo is multi-color; this single-color
// currentColor version is on-brand for the monochrome UI.
export function SlackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </Svg>
  );
}

// Source: Simple Icons — anthropic (Claude Code)
export function AnthropicIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </Svg>
  );
}

// Source: Simple Icons — openai (Codex)
export function OpenAIIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </Svg>
  );
}

// Source: Simple Icons — opencode (OpenCode)
export function OpenCodeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
    </Svg>
  );
}

// OpenRouter is not in Simple Icons. This is the official OpenRouter mark (two
// routing arrows). It has its own viewBox and mixes strokes with fills, so it
// can't use the shared Svg wrapper — but it still renders in currentColor to
// stay monochrome with the rest of the UI.
export function OpenRouterIcon({ size = 20, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-45 32.23 556.5 433.48"
      fill="none"
      stroke="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M3 248.945C18 248.945 76 236 106 219C136 202 136 202 198 158C276.497 102.293 332 120.945 423 120.945" strokeWidth="90" />
      <path d="M511 121.5L357.25 210.268L357.25 32.7324L511 121.5Z" fill="currentColor" stroke="none" />
      <path d="M0 249C15 249 73 261.945 103 278.945C133 295.945 133 295.945 195 339.945C273.497 395.652 329 377 420 377" strokeWidth="90" />
      <path d="M508 376.445L354.25 287.678L354.25 465.213L508 376.445Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Fireflies.ai is not in Simple Icons. This is a clean spark/firefly mark (a
// glowing dot with four rays) that reads as a logo in the ink color.
// TODO: replace with official mark
export function FirefliesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 0.5 13 6h-2zM12 23.5 11 18h2zM0.5 12 6 11v2zM23.5 12 18 13v-2z" />
    </Svg>
  );
}

// Source: Simple Icons — googlegemini (Gemini CLI). The four-point spark.
export function GeminiIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12" />
    </Svg>
  );
}

// Cursor's mark is a dimensional cube; this is a clean monochrome prism that
// reads as the logo at small sizes. TODO: replace with official mark.
export function CursorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 1 22.5 7v10L12 23 1.5 17V7L12 1zm0 2.3L4.4 7.65 12 12l7.6-4.35L12 3.3zM3.5 9.05v6.8l7.5 4.3v-6.8l-7.5-4.3zm17 0-7.5 4.3v6.8l7.5-4.3v-6.8z" />
    </Svg>
  );
}

// Silhouette from the user-supplied antigravity-color.svg; inherits UI color.
export function AntigravityIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" />
    </Svg>
  );
}

const ICONS = {
  github: GithubIcon,
  linear: LinearIcon,
  slack: SlackIcon,
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  opencode: OpenCodeIcon,
  openrouter: OpenRouterIcon,
  fireflies: FirefliesIcon,
  gemini: GeminiIcon,
  cursor: CursorIcon,
  antigravity: AntigravityIcon,
} as const;

export type BrandName = keyof typeof ICONS;

export function BrandIcon({ name, size, className }: { name: BrandName; size?: number; className?: string }) {
  const Icon = ICONS[name];
  if (!Icon) return null;
  return <Icon size={size} className={className} />;
}

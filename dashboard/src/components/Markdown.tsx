"use client";
import { useEffect, useState } from "react";

// Renders markdown (bold, lists, code, links, …) as sanitized HTML. Parsing
// and sanitizing libs are dynamically imported so they don't bloat routes
// that never render markdown.
export function MarkdownContent({ md, className }: { md: string; className?: string }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import("marked"),
      import("dompurify"),
    ]).then(([{ marked }, { default: DOMPurify }]) => {
      if (cancelled) return;
      const result = marked.parse(md);
      const resolve = (raw: string) => {
        // DOMPurify works in browser only; on SSR-less env fallback to raw
        const clean = typeof DOMPurify.sanitize === "function"
          ? DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
          : raw;
        if (!cancelled) setHtml(clean);
      };
      if (typeof result === "string") resolve(result);
      else result.then(resolve);
    });
    return () => { cancelled = true; };
  }, [md]);

  return (
    <div
      className={`markdown-body ${className ?? ""}`}
      style={{ lineHeight: 1.7 }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

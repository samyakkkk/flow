# Flow — Design System

Warm, editorial, confident. Cream paper, one yellow accent, serif headlines, mono
labels. Adapted from the Edra reference. Used across the dashboard, the Ask view,
and the landing page — Flow should feel like one considered product.

## Feeling

Calm and premium, not techy-dark. It reads like a well-set magazine that happens
to be software. Lots of space. Few colors. The graph (the brain) and the answers
are the color; the chrome stays quiet.

## Color tokens

```
--cream        rgb(255, 255, 249)   page background
--sand         rgb(234, 235, 228)   secondary background / alt sections
--paper        rgb(242, 243, 235)   cards, inputs, muted surfaces
--ink          rgb(54, 55, 38)      near-black, dark surfaces & strong headings
--text         rgb(73, 73, 57)      body text
--text-muted   rgb(133, 134, 122)   secondary text, labels
--accent       rgb(255, 247, 129)   THE yellow — primary actions, highlights, live state
--line         rgba(0,0,0,0.06)     hairline borders (border-black/5)

Semantic (used sparingly, muted to fit the palette):
--ok           rgb(90, 140, 90)     healthy / up-to-date
--busy         the accent yellow    indexing / catching-up / live
--warn         rgb(184, 134, 60)    needs attention / propose
--danger       rgb(168, 80, 70)     error (desaturated brick, not pure red)
```

Dark surfaces (feature cards, the final CTA, the graph canvas backdrop) use `--ink`
with `--paper`/`--cream` text and the accent for emphasis.

## Type

- **Display / headings** — **Lora** (serif). Tracking-tight, leading ~1.1–1.2. This carries the editorial feel. Sizes: hero 48/37, section 37, card 24, sub 20.
- **Body** — **Inter**. 17px lead, 15px default, relaxed leading. Calm and readable.
- **Labels / meta / code** — **Space Mono**. UPPERCASE, tracking-widest, ~12–13px, `--text-muted`. Every section starts with a mono kicker + a small dot.

Load via Google Fonts (Lora 400/500/600, Inter 400/500, Space Mono 400).

## Shape & depth

- Radii: `sm 4 · md 6 · lg 8 · xl 14 · full`. Cards use lg; pills/buttons use full; big panels use lg/xl.
- Borders: hairline `1px --line`. That's the primary separator — not shadows.
- Shadows: barely-there. `sm: 0 0 2px rgba(0,0,0,.06)`, `md: 0 0 3px rgba(0,0,0,.10)`. Used on the accent button and on hover, never as heavy elevation.
- Generous padding: cards 24–32px, sections 80–128px vertical.

## Components

**Section kicker** — the signature. A 2px dot + Space Mono uppercase tracking-widest label in `--text-muted`, above a Lora heading.
```
• PLATFORM
How Flow works        ← Lora, large
```

**Primary button** — pill, `--accent` fill, `--ink` text, Space Mono uppercase tracking-widest, tiny `↗` arrow, `sm` shadow, `hover:scale-[1.02]`.

**Secondary button** — pill, `--paper` fill, `1px --line` border, `--ink` text, mono uppercase. `hover:bg-cream`.

**Card** — `--paper` bg, `lg` radius, `1px --line` border, 24–32 padding. A **feature/emphasis card** flips to `--ink` bg with `--paper` text.

**Input** — `--paper` (or cream on paper), `1px --line`, `md` radius, Inter. Focus: accent-tinted ring, no harsh glow. Secrets show a masked placeholder.

**Status pill** — small, rounded-full, mono uppercase. Live/indexing = accent fill; healthy = subtle `--ok` on paper; needs-attention = `--warn`. A small pulsing dot for "live."

**Chip (citation)** — mono, small, `--paper` bg, hairline border: `api-service · auth.ts:44`.

## Motion

- Scroll/enter: fade + 20px rise, 0.8s ease-out (Edra's `data-animation-on-scroll`).
- **Node pop** (the brain growing): new graph nodes scale-in 0→1 with a soft accent flash, then settle. This is the emotional beat — make it feel alive.
- Button hover: `scale-1.02`. Never bouncy. Everything is calm and quick (150–250ms) except the deliberate 0.8s entrances.

## The brain (graph) on this palette

- Canvas: `--ink` or a deep warm dark, so the nodes glow. Nodes tinted by type from a warm-analogous set (services = accent-adjacent, resources = sand, concepts = muted ink) with a legend.
- Edges: thin, `--paper` at low opacity. Highlighted subgraph (answering): used nodes glow accent, the rest dim to ~20%.
- It should look like a constellation forming, not a debug dump.

## Do / Don't

- **Do** let cream space breathe; lead with serif; keep one accent.
- **Do** speak in plain sentences on every primary surface.
- **Don't** reintroduce the dark-slate + indigo look, multiple accent colors, heavy shadows, or dense data-tables as a landing view.
- **Don't** show raw taxonomy words (noise/suppressed/classification) anywhere a normal user looks.

## Implementation

- Tokens live in `dashboard/src/app/globals.css` as CSS variables + Tailwind v4 `@theme`. Fonts loaded in `layout.tsx`.
- Same tokens mirrored into the landing page so both match.
- A tiny set of primitives (`Button`, `Card`, `Kicker`, `StatusPill`, `Chip`, `Input`) so every screen is built from the system, not ad-hoc classes.

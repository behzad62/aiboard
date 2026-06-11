# SEO for the AI Discussion Board SPA — Design

Date: 2026-06-11
Status: Approved (user, 2026-06-11)

## Goal

Make the statically-exported, fully client-side app discoverable and well-presented
in search engines and link previews. The app already ships prerendered HTML
(`output: "export"`), so the work is metadata, crawlable content, and crawl-control
files — not a rendering migration.

## Decisions (from user)

- **Deployment URL**: not deployed yet → use a placeholder constant, changeable in one place.
- **Scope**: technical SEO + landing copy + an About page. No per-feature pages.
- **OG image**: generate a static branded 1200×630 image, shipped in `public/`.

## What exists today

- One basic `title`/`description` in `app/layout.tsx`; no OG/Twitter tags, no canonical, no per-page titles.
- No `sitemap.xml`, no `robots.txt` (`public/` holds only `runner.mjs`).
- All three pages (`/`, `/discussion`, `/settings`) are `"use client"`, so none can export `Metadata`.
- Almost no crawlable prose: the dashboard is a tool UI; exported HTML is mostly controls and loading states.
- `/discussion?id=` and `/settings` render per-user local data — worthless or empty for crawlers.

## Design

### 1. Site constants — `lib/site.ts`

```ts
export const SITE_URL = "https://example.com"; // TODO: set when deployed
export const SITE_NAME = "AI Discussion Board";
export const SITE_DESCRIPTION = "..."; // one canonical description used everywhere
```

Consumed by layout metadata, sitemap, robots, and JSON-LD. Changing `SITE_URL`
after deployment is the only edit needed.

### 2. Metadata layer

- **`app/layout.tsx`**: add `metadataBase: new URL(SITE_URL)`, title template
  (`{ default: SITE_NAME, template: "%s · AI Discussion Board" }`), default
  description, and OpenGraph + Twitter-card defaults referencing `/og.png`
  (`summary_large_image`).
- **Server-wrapper pattern**: each `"use client"` page is renamed to a client
  component file; `page.tsx` becomes a small server component that exports
  `Metadata` and renders it.
  - `app/page.tsx` → wraps `components/DashboardPage.tsx` (moved client code).
    Exports home metadata + a JSON-LD `SoftwareApplication` `<script>`
    (name, description, `applicationCategory: "DeveloperApplication"`,
    `operatingSystem: "Web browser"`, free offer).
  - `app/discussion/page.tsx` → wraps moved client component; metadata sets
    `robots: { index: false }` (per-user content, thin pages).
  - `app/settings/page.tsx` → same, `robots: { index: false }`.
- **`app/about/page.tsx`** (new, pure server/static): real crawlable prose —
  what the app does, who it's for, how the discussion modes work
  (panel / debate / specialist / build), the local-first privacy story
  (keys and data never leave the browser), and a short FAQ. Has its own
  `Metadata` (title "About", description). Linked from the header.

### 3. Landing copy on the dashboard

A static prose section rendered unconditionally below the tool UI in the
dashboard client component (so it lands in the exported `index.html`):
value-proposition heading, 2–3 paragraphs, feature bullets. The page keeps a
single `<h1>` carrying the app name + value proposition.

### 4. Sitemap & robots — Next conventions

- `app/sitemap.ts` → emits `out/sitemap.xml` at build; lists `/` and `/about`
  (absolute URLs from `SITE_URL`).
- `app/robots.ts` → emits `out/robots.txt`; allow all, `sitemap:` pointing at
  `SITE_URL/sitemap.xml`. (No `Disallow` for tool pages — they're excluded via
  meta `noindex`, which is the correct mechanism; robots-blocking would hide
  the noindex.)

Both conventions are compatible with `output: "export"` (generated at build time).

### 5. OG image

`public/og.png`, 1200×630, dark theme matching the app (app name, tagline,
simple branding). Referenced by the layout's OG/Twitter defaults. Authored as
SVG and rendered to PNG during this work (one-time asset, committed).

## Error handling

Nothing dynamic is added; all new code runs at build time. The only runtime
surface is static JSX. A wrong `SITE_URL` degrades canonical/OG URLs but breaks
nothing.

## Testing / verification

- `npm run build` (static export) — must succeed.
- Inspect `out/index.html`: title, description, OG/Twitter tags, JSON-LD,
  landing prose present in raw HTML.
- Inspect `out/about/index.html` (or `about.html`): title + prose present.
- Inspect `out/sitemap.xml`, `out/robots.txt`.
- `out/discussion/...` HTML contains `noindex` robots meta.
- `npm run lint` passes.
- Existing tsx test scripts unaffected (no engine/provider code touched).

## Out of scope

Per-feature marketing pages, Google Search Console submission, backlink
outreach, performance work (bundle splitting), and setting the real domain —
all post-deploy user actions.

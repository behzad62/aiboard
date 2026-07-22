import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Required for output: "export" — generated once at build time.
export const dynamic = "force-static";

// Last meaningful CONTENT change per page, not the last time the file was
// touched — a metadata refactor is not a reason to tell crawlers the page is
// new. Update the entry when you change what the page actually says.
const pages: { path: string; lastModified: string; priority: number }[] = [
  { path: "/", lastModified: "2026-07-22", priority: 1 },
  { path: "/about", lastModified: "2026-07-22", priority: 0.8 },
  { path: "/multi-model-ai-discussions", lastModified: "2026-06-17", priority: 0.7 },
  { path: "/ai-debate-tool", lastModified: "2026-06-17", priority: 0.7 },
  { path: "/build-mode", lastModified: "2026-07-13", priority: 0.7 },
  { path: "/runner-guide", lastModified: "2026-07-13", priority: 0.6 },
  { path: "/games", lastModified: "2026-07-22", priority: 0.6 },
  { path: "/games/chess", lastModified: "2026-07-22", priority: 0.5 },
  { path: "/games/connect-four", lastModified: "2026-07-22", priority: 0.5 },
  { path: "/games/battleship", lastModified: "2026-07-22", priority: 0.5 },
  { path: "/games/codenames", lastModified: "2026-07-22", priority: 0.5 },
  { path: "/games/fireworks", lastModified: "2026-07-22", priority: 0.5 },
];

// /settings, /discussion, and /benchmark are deliberately absent: they render
// per-user data held in this browser and are marked noindex.
export default function sitemap(): MetadataRoute.Sitemap {
  return pages.map((page) => ({
    url: `${SITE_URL}${page.path}`,
    lastModified: new Date(page.lastModified),
    changeFrequency: "monthly",
    priority: page.priority,
  }));
}

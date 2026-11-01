import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Required for output: "export" — generated once at build time.
export const dynamic = "force-static";

// Last meaningful CONTENT change per page, not the last time the file was
// touched — a metadata refactor is not a reason to tell crawlers the page is
// new. Update the entry when you change what the page actually says.
const pages: { path: string; lastModified: string; priority: number }[] = [
  { path: "/", lastModified: "2026-10-15", priority: 1 },
  { path: "/about", lastModified: "2026-10-15", priority: 0.8 },
  { path: "/runner-guide", lastModified: "2026-10-31", priority: 0.6 },
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

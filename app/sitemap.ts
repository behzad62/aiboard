import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Required for output: "export" — generated once at build time.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/about`, changeFrequency: "monthly", priority: 0.8 },
  ];
}

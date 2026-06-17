import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Required for output: "export" — generated once at build time.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/about`, changeFrequency: "monthly", priority: 0.8 },
    {
      url: `${SITE_URL}/multi-model-ai-discussions`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/ai-debate-tool`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    { url: `${SITE_URL}/build-mode`, changeFrequency: "monthly", priority: 0.7 },
  ];
}

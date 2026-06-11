import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Required for output: "export" — generated once at build time.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  // Allow everything: the tool pages are excluded via meta noindex, which
  // crawlers can only see if they are NOT robot-blocked.
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}

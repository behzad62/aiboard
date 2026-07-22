import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // Fully client-side app: export to static HTML/JS so it can be hosted on any
  // static host (GitHub Pages, S3, Netlify) with no server.
  output: "export",
  images: { unoptimized: true },
  turbopack: { root: repoRoot },
};

export default nextConfig;

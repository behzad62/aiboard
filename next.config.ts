import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully client-side app: export to static HTML/JS so it can be hosted on any
  // static host (GitHub Pages, S3, Netlify) with no server.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;

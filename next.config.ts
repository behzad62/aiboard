import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const anthropicBrowserFsShim = "./lib/client/shims/anthropic-node-fs.ts";
const anthropicBrowserPathShim = "./lib/client/shims/anthropic-node-path.ts";
const anthropicBrowserFsShimAbsolute = join(
  repoRoot,
  "lib/client/shims/anthropic-node-fs.ts"
);
const anthropicBrowserPathShimAbsolute = join(
  repoRoot,
  "lib/client/shims/anthropic-node-path.ts"
);
const anthropicBrowserNodeModules = new Map([
  ["node:fs", anthropicBrowserFsShimAbsolute],
  ["node:path", anthropicBrowserPathShimAbsolute],
]);

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // Fully client-side app: export to static HTML/JS so it can be hosted on any
  // static host (GitHub Pages, S3, Netlify) with no server.
  output: "export",
  images: { unoptimized: true },
  turbopack: {
    root: repoRoot,
    resolveAlias: {
      "node:fs": { browser: anthropicBrowserFsShim },
      "node:path": { browser: anthropicBrowserPathShim },
    },
  },
  webpack(config, { isServer, webpack }) {
    if (!isServer) {
      config.plugins ??= [];
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^node:(fs|path)$/,
          (resource: { request: string }) => {
            const replacement = anthropicBrowserNodeModules.get(resource.request);
            if (replacement) resource.request = replacement;
          }
        )
      );
    }
    return config;
  },
};

export default nextConfig;

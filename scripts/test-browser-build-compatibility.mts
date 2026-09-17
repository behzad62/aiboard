import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const require = createRequire(import.meta.url);
interface WebpackStats {
  hasErrors(): boolean;
  toString(options: Record<string, boolean>): string;
  toJson(options: Record<string, boolean>): {
    modules?: { name?: string }[];
  };
}
type BrowserWebpack = ((
  config: unknown,
  callback: (error: Error | null, stats?: WebpackStats) => void
) => void) & {
  NormalModuleReplacementPlugin: new (...args: unknown[]) => unknown;
};
const webpack = (
  require("next/dist/compiled/webpack/webpack.js") as { webpack: BrowserWebpack }
).webpack;

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const css = await readFile(join(repoRoot, "app", "globals.css"), "utf8");

assert.equal(
  packageJson.imports?.["#tailwind-config"],
  "./tailwind.config.ts",
  "package import map must anchor the Tailwind config"
);
assert.match(css, /@config\s+["']#tailwind-config["']/);

for (const file of ["anthropic-node-fs.ts", "anthropic-node-path.ts"]) {
  assert.equal(
    existsSync(join(repoRoot, "lib", "client", "shims", file)),
    true,
    `${file} must exist`
  );
}

for (const from of [join(repoRoot, "app", "globals.css"), join(repoRoot, "globals.css")]) {
  const output = await postcss([tailwind()]).process(css, { from });
  assert.ok(output.css.length > 1_000, `Tailwind emits CSS for ${from}`);
}

const fsShim = await import(
  pathToFileURL(join(repoRoot, "lib", "client", "shims", "anthropic-node-fs.ts")).href
);
const pathShim = await import(
  pathToFileURL(join(repoRoot, "lib", "client", "shims", "anthropic-node-path.ts")).href
);
assert.throws(
  () => fsShim.promises.readFile("credentials"),
  /local credential files are unavailable in the browser/i
);
assert.throws(
  () => pathShim.join("credentials"),
  /local credential paths are unavailable in the browser/i
);

const loaded = await import(pathToFileURL(join(repoRoot, "next.config.ts")).href);
const nextConfig = loaded.default;
assert.equal(
  nextConfig.turbopack?.resolveAlias?.["node:fs"]?.browser,
  "./lib/client/shims/anthropic-node-fs.ts"
);
assert.equal(
  nextConfig.turbopack?.resolveAlias?.["node:path"]?.browser,
  "./lib/client/shims/anthropic-node-path.ts"
);
assert.equal(typeof nextConfig.webpack, "function");

const work = await mkdtemp(join(tmpdir(), "aiboard-anthropic-browser-"));
try {
  const entry = join(work, "entry.mjs");
  await writeFile(
    entry,
    [
      'import Anthropic from "@anthropic-ai/sdk";',
      "export function create(fetchImpl) {",
      '  return new Anthropic({ apiKey: "test-key", dangerouslyAllowBrowser: true, fetch: fetchImpl });',
      "}",
    ].join("\n"),
    "utf8"
  );
  const baseConfig = {
    mode: "development",
    context: repoRoot,
    entry,
    target: "web",
    output: { path: join(work, "dist"), filename: "bundle.js", library: { type: "commonjs2" } },
    resolve: {
      extensions: [".ts", ".tsx", ".js", ".mjs"],
      modules: [join(repoRoot, "node_modules")],
    },
    plugins: [],
  };
  const configured = nextConfig.webpack(baseConfig as never, {
    isServer: false,
    webpack: webpack as never,
  } as never);
  const stats = await new Promise<WebpackStats>((resolveStats, rejectStats) => {
    webpack(configured, (error, value) => {
      if (error) rejectStats(error);
      else if (!value) rejectStats(new Error("webpack returned no stats"));
      else resolveStats(value);
    });
  });
  assert.equal(
    stats.hasErrors(),
    false,
    stats.toString({ all: false, errors: true, warnings: true })
  );
  const moduleNames = stats.toJson({ all: false, modules: true }).modules?.map((m) => m.name) ?? [];
  assert.ok(moduleNames.some((name) => name?.includes("anthropic-node-fs.ts")));
  assert.ok(moduleNames.some((name) => name?.includes("anthropic-node-path.ts")));
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log("PASS");

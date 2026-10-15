/** SEO page discoverability checks (run: npx tsx scripts/test-seo-pages.mts) */
import fs from "node:fs";
import path from "node:path";

// Public, indexable pages. The tool pages (/settings, /discussion,
// /benchmark) are per-user and stay out of the sitemap.
const publicPages = ["about", "runner-guide"] as const;
// Retired 2026-10-15 when AI Board was refocused as a chat + build harness.
const retiredPages = [
  "multi-model-ai-discussions",
  "ai-debate-tool",
  "build-mode",
  "games",
] as const;

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const exists = (file: string) => fs.existsSync(path.join(process.cwd(), file));

const sitemap = read("app/sitemap.ts");
const layout = read("app/layout.tsx");

for (const slug of publicPages) {
  const pagePath = `app/${slug}/page.tsx`;
  check(`${slug} page file exists`, exists(pagePath), pagePath);
  if (exists(pagePath)) {
    const page = read(pagePath);
    check(`${slug} has metadata`, page.includes("export const metadata"), pagePath);
    check(`${slug} links back to app`, page.includes('href="/"'), pagePath);
  }
  check(`${slug} is included in sitemap`, sitemap.includes(`"/${slug}"`), slug);
  check(`${slug} is linked from the layout footer`, layout.includes(`href="/${slug}"`), slug);
}

for (const slug of retiredPages) {
  check(`${slug} page is removed`, !exists(`app/${slug}`), slug);
  check(`${slug} is not in sitemap`, !sitemap.includes(`"/${slug}`), slug);
}

process.exit(failed === 0 ? 0 : 1);

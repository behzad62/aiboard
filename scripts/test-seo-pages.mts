/** SEO page discoverability checks (run: npx tsx scripts/test-seo-pages.mts) */
import fs from "node:fs";
import path from "node:path";

const requiredPages = [
  "multi-model-ai-discussions",
  "ai-debate-tool",
  "build-mode",
] as const;

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const exists = (file: string) => fs.existsSync(path.join(process.cwd(), file));

const about = read("app/about/page.tsx");
const sitemap = read("app/sitemap.ts");
const layout = read("app/layout.tsx");

for (const slug of requiredPages) {
  const pagePath = `app/${slug}/page.tsx`;
  check(`${slug} page file exists`, exists(pagePath), pagePath);
  if (exists(pagePath)) {
    const page = read(pagePath);
    check(`${slug} has metadata`, page.includes("export const metadata"), pagePath);
    check(`${slug} has canonical metadata`, page.includes(`canonical: "/${slug}"`), pagePath);
    check(`${slug} links back to app`, page.includes('href="/"'), pagePath);
  }

  check(`${slug} is linked from About`, about.includes(`href="/${slug}"`), slug);
  check(`${slug} is included in sitemap`, sitemap.includes(`/${slug}`), slug);
  check(`${slug} is not in global header nav`, !layout.includes(`href="/${slug}"`), slug);
}

process.exit(failed === 0 ? 0 : 1);

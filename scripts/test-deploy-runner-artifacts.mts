/* Static deploy runner artifact checks (run after npm run build). */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import JSZip from "jszip";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function nodeCheck(path: string): boolean {
  try {
    execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const sourceAccountRunner = "lib/account-provider-runner.mjs";
const sourceBenchRunner = "scripts/bench-runner.mjs";
const publicAccountRunner = "public/account-provider-runner.mjs";
const exportedAccountRunner = "out/account-provider-runner.mjs";
const publicBenchRunner = "public/bench-runner.mjs";
const exportedBenchRunner = "out/bench-runner.mjs";
const publicRunner = "public/runner.mjs";
const exportedRunner = "out/runner.mjs";
const publicManifest = "public/runner-manifest.json";
const exportedManifest = "out/runner-manifest.json";
const publicNativeRunner = "public/aiboard-runner-v2.zip";
const exportedNativeRunner = "out/aiboard-runner-v2.zip";

function builtInSkillPaths(): string[] {
  return readdirSync("runner-v2/skills", { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "SKILL.md")
    .map((entry) => relative("runner-v2/skills", `${entry.parentPath}/${entry.name}`).replaceAll("\\", "/"))
    .sort();
}

async function checkNativeRunnerArchive(path: string): Promise<void> {
  if (!existsSync(path)) return;

  try {
    const archive = await JSZip.loadAsync(readFileSync(path));
    const packageFile = archive.file("package.json");
    const readmeFile = archive.file("README.md");
    const licenseFile = archive.file("LICENSE");
    const cliFile = archive.file("src/cli.ts");

    check(`${path} contains package.json`, packageFile !== null);
    check(`${path} contains README.md`, readmeFile !== null);
    check(`${path} contains LICENSE`, licenseFile !== null);
    check(`${path} contains src/cli.ts`, cliFile !== null);

    if (packageFile) {
      const packageJson = JSON.parse(await packageFile.async("string")) as {
        license?: string;
        engines?: { node?: string };
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const rootPackageJson = JSON.parse(read("package.json")) as { license?: string };
      check(`${path} uses the root package license`, packageJson.license === rootPackageJson.license);
      check(`${path} requires Node.js 24.18.0 or newer`, packageJson.engines?.node === ">=24.18.0");
      check(`${path} starts src/cli.ts`, packageJson.scripts?.start === "tsx src/cli.ts");
      check(
        `${path} installs Chromium through Playwright`,
        packageJson.scripts?.["setup:browser"] === "playwright install chromium"
      );
      check(`${path} includes tsx`, typeof packageJson.dependencies?.tsx === "string");
      check(`${path} includes Playwright`, typeof packageJson.dependencies?.playwright === "string");
    }

    if (licenseFile) {
      check(`${path} LICENSE matches root LICENSE`, (await licenseFile.async("string")) === read("LICENSE"));
    }

    if (readmeFile) {
      const readme = await readmeFile.async("string");
      check(`${path} README requires Git`, /\bGit\b/.test(readme));
      check(`${path} README documents npm install`, /\bnpm install\b/.test(readme));
      check(`${path} README documents browser setup`, /\bnpm run setup:browser\b/.test(readme));
      check(
        `${path} README documents standalone startup`,
        /npm start -- --project [^\r\n]+ --state-dir [^\r\n]+ --port 8787/.test(readme)
      );
    }

    if (cliFile) {
      check(
        `${path} CLI matches Runner V2 source`,
        (await cliFile.async("string")) === read("runner-v2/src/cli.ts")
      );
    }

    for (const skillPath of builtInSkillPaths()) {
      const archivePath = `skills/${skillPath}`;
      const skillFile = archive.file(archivePath);
      check(`${path} contains ${archivePath}`, skillFile !== null);
      if (skillFile) {
        check(
          `${path} ${archivePath} matches Runner V2 source`,
          (await skillFile.async("string")) === read(`runner-v2/skills/${skillPath}`)
        );
      }
    }
  } catch (error) {
    check(`${path} is a readable ZIP archive`, false, error instanceof Error ? error.message : error);
  }
}

for (const path of [
  publicAccountRunner,
  exportedAccountRunner,
  publicBenchRunner,
  exportedBenchRunner,
]) {
  check(`${path} exists`, existsSync(path));
}
for (const path of [publicRunner, exportedRunner, publicManifest, exportedManifest]) {
  check(`${path} is retired`, !existsSync(path));
}
for (const path of [publicNativeRunner, exportedNativeRunner]) {
  check(`${path} exists`, existsSync(path));
  await checkNativeRunnerArchive(path);
}

if (existsSync(publicAccountRunner) && existsSync(sourceAccountRunner)) {
  check(
    "public account runner matches source",
    read(publicAccountRunner) === read(sourceAccountRunner)
  );
}

if (existsSync(exportedAccountRunner) && existsSync(sourceAccountRunner)) {
  check(
    "exported account runner matches source",
    read(exportedAccountRunner) === read(sourceAccountRunner)
  );
}

if (existsSync(publicBenchRunner) && existsSync(sourceBenchRunner)) {
  check("public benchmark runner matches source", read(publicBenchRunner) === read(sourceBenchRunner));
}

if (existsSync(exportedBenchRunner) && existsSync(sourceBenchRunner)) {
  check(
    "exported benchmark runner matches source",
    read(exportedBenchRunner) === read(sourceBenchRunner)
  );
}

if (existsSync(exportedAccountRunner)) {
  check("exported account runner is valid JavaScript", nodeCheck(exportedAccountRunner));
}
if (existsSync(exportedBenchRunner)) {
  check("exported benchmark runner is valid JavaScript", nodeCheck(exportedBenchRunner));
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

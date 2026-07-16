/* Static deploy runner artifact checks (run after npm run build). */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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

function normalizeLf(value: string): string {
  return value.replace(/\r\n?/g, "\n");
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
const publicAccountRunnerZip = "public/aiboard-account-provider-runner.zip";
const exportedAccountRunnerZip = "out/aiboard-account-provider-runner.zip";
const publicBenchRunner = "public/bench-runner.mjs";
const exportedBenchRunner = "out/bench-runner.mjs";
const publicRunner = "public/runner.mjs";
const exportedRunner = "out/runner.mjs";
const publicManifest = "public/runner-manifest.json";
const exportedManifest = "out/runner-manifest.json";
const publicNativeRunner = "public/aiboard-runner-v2.zip";
const exportedNativeRunner = "out/aiboard-runner-v2.zip";

function publishNativeRunnerHash(): string {
  execFileSync(process.execPath, ["scripts/publish-downloads.mjs"], { stdio: "pipe" });
  return createHash("sha256").update(readFileSync(publicNativeRunner)).digest("hex");
}

const firstPublishedNativeRunnerHash = publishNativeRunnerHash();
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
const secondPublishedNativeRunnerHash = publishNativeRunnerHash();
check(
  "Runner V2 ZIP publication is reproducible",
  firstPublishedNativeRunnerHash === secondPublishedNativeRunnerHash,
  { firstPublishedNativeRunnerHash, secondPublishedNativeRunnerHash }
);

function textFilePaths(directory: string, extension: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => relative(directory, `${entry.parentPath}/${entry.name}`).replaceAll("\\", "/"))
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
      const archivedLicense = await licenseFile.async("string");
      check(`${path} LICENSE uses LF line endings`, !archivedLicense.includes("\r"));
      check(`${path} LICENSE matches normalized root LICENSE`, archivedLicense === normalizeLf(read("LICENSE")));
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

    for (const sourcePath of textFilePaths("runner-v2/src", ".ts")) {
      const archivePath = `src/${sourcePath}`;
      const sourceFile = archive.file(archivePath);
      check(`${path} contains ${archivePath}`, sourceFile !== null);
      if (sourceFile) {
        const archivedSource = await sourceFile.async("string");
        check(`${path} ${archivePath} uses LF line endings`, !archivedSource.includes("\r"));
        check(
          `${path} ${archivePath} matches normalized Runner V2 source`,
          archivedSource === normalizeLf(read(`runner-v2/src/${sourcePath}`))
        );
      }
    }

    for (const sourcePath of [
      "managed-process-supervisor.mjs",
      "managed-process-job-host.ps1",
    ]) {
      const archivePath = `src/${sourcePath}`;
      const sourceFile = archive.file(archivePath);
      check(`${path} contains ${archivePath}`, sourceFile !== null);
      const archivedSource = sourceFile
        ? await sourceFile.async("nodebuffer")
        : undefined;
      check(
        `${path} ${archivePath} bytes match Runner V2 source`,
        archivedSource?.equals(readFileSync(`runner-v2/src/${sourcePath}`)) === true
      );
    }

    for (const skillPath of textFilePaths("runner-v2/skills", ".md")) {
      const archivePath = `skills/${skillPath}`;
      const skillFile = archive.file(archivePath);
      check(`${path} contains ${archivePath}`, skillFile !== null);
      if (skillFile) {
        const archivedSkill = await skillFile.async("string");
        check(`${path} ${archivePath} uses LF line endings`, !archivedSkill.includes("\r"));
        check(
          `${path} ${archivePath} matches normalized Runner V2 source`,
          archivedSkill === normalizeLf(read(`runner-v2/skills/${skillPath}`))
        );
      }
    }
  } catch (error) {
    check(`${path} is a readable ZIP archive`, false, error instanceof Error ? error.message : error);
  }
}

async function checkAccountRunnerArchive(path: string): Promise<void> {
  if (!existsSync(path)) return;
  try {
    const archive = await JSZip.loadAsync(readFileSync(path));
    const packageFile = archive.file("package.json");
    const runnerFile = archive.file("account-provider-runner.mjs");
    const sdkFile = archive.file("account-provider-copilot-sdk.mjs");
    const readmeFile = archive.file("README.md");
    check(`${path} contains account-provider-runner.mjs`, runnerFile !== null);
    check(`${path} contains account-provider-copilot-sdk.mjs`, sdkFile !== null);
    check(`${path} contains package.json`, packageFile !== null);
    check(`${path} contains README.md`, readmeFile !== null);
    if (packageFile) {
      const packageJson = JSON.parse(await packageFile.async("string")) as {
        dependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      check(`${path} pins the Copilot SDK dependency`, packageJson.dependencies?.["@github/copilot-sdk"] === "1.0.6", packageJson);
      check(`${path} starts the account runner`, packageJson.scripts?.start === "node account-provider-runner.mjs", packageJson);
    }
    if (runnerFile && existsSync(sourceAccountRunner)) {
      check(`${path} account runner source matches`, await runnerFile.async("string") === read(sourceAccountRunner));
    }
    if (sdkFile) {
      const tempPath = await writeTempFile(path, sdkFile);
      check(`${path} SDK adapter is valid JavaScript`, nodeCheck(tempPath), path);
      unlinkSync(tempPath);
    }
  } catch (error) {
    check(`${path} is a readable Copilot account-runner ZIP`, false, error instanceof Error ? error.message : error);
  }
}

async function writeTempFile(archivePath: string, file: { async(type: "nodebuffer"): Promise<Buffer> }): Promise<string> {
  const tempPath = `${archivePath}.sdk-check.mjs`;
  writeFileSync(tempPath, await file.async("nodebuffer"));
  return tempPath;
}

for (const path of [
  publicAccountRunner,
  exportedAccountRunner,
  publicAccountRunnerZip,
  exportedAccountRunnerZip,
  publicBenchRunner,
  exportedBenchRunner,
]) {
  check(`${path} exists`, existsSync(path));
}
await checkAccountRunnerArchive(publicAccountRunnerZip);
await checkAccountRunnerArchive(exportedAccountRunnerZip);
for (const path of [publicRunner, exportedRunner, publicManifest, exportedManifest]) {
  check(`${path} is retired`, !existsSync(path));
}
for (const path of [publicNativeRunner, exportedNativeRunner]) {
  check(`${path} exists`, existsSync(path));
  await checkNativeRunnerArchive(path);
}
if (existsSync(publicNativeRunner) && existsSync(exportedNativeRunner)) {
  check(
    "public and exported Runner V2 ZIPs are byte-identical",
    readFileSync(publicNativeRunner).equals(readFileSync(exportedNativeRunner))
  );
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

// Publish the browser-downloadable transports and the standalone Runner V2
// source distribution used by hosted AI Board deployments.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, "..");
const publicDirectory = path.join(root, "public");
const runnerDirectory = path.join(root, "runner-v2");
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const accountRunnerSource = path.join(root, "lib", "account-provider-runner.mjs");
const accountSdkSource = path.join(root, "lib", "account-provider-copilot-sdk.mjs");
const downloads = [
  [accountRunnerSource, path.join(publicDirectory, "account-provider-runner.mjs")],
  [path.join(scripts, "bench-runner.mjs"), path.join(publicDirectory, "bench-runner.mjs")],
];

function pinnedVersion(specifier, dependency) {
  if (typeof specifier !== "string") {
    throw new Error(`Cannot publish Runner V2: ${dependency} has no root package version.`);
  }
  const version = specifier.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (!version) {
    throw new Error(`Cannot publish Runner V2: ${dependency} is not pinned from ${specifier}.`);
  }
  return version;
}

function normalizedTextFile(source) {
  return fs.readFileSync(source, "utf8").replace(/\r\n?/g, "\n");
}

function archiveFileContent(source) {
  return [".ts", ".md"].includes(path.extname(source).toLowerCase())
    ? normalizedTextFile(source)
    : fs.readFileSync(source);
}

function addDirectory(zip, sourceDirectory, archiveDirectory) {
  if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
    throw new Error(`Cannot publish Runner V2: missing ${path.relative(root, sourceDirectory)}.`);
  }

  const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const source = path.join(sourceDirectory, entry.name);
    const destination = path.posix.join(archiveDirectory, entry.name);
    if (entry.isDirectory()) {
      addDirectory(zip, source, destination);
    } else if (entry.isFile()) {
      zip.file(destination, archiveFileContent(source), { date: new Date(0), createFolders: false });
    }
  }
}

async function publishNativeRunner() {
  const cli = path.join(runnerDirectory, "src", "cli.ts");
  const skills = path.join(runnerDirectory, "skills");
  if (!fs.existsSync(cli)) {
    throw new Error("Cannot publish Runner V2: missing runner-v2/src/cli.ts.");
  }

  const zip = new JSZip();
  addDirectory(zip, path.join(runnerDirectory, "src"), "src");
  addDirectory(zip, skills, "skills");

  const tsxVersion = pinnedVersion(rootPackage.devDependencies?.tsx, "tsx");
  const playwrightVersion = pinnedVersion(
    rootPackage.dependencies?.playwright ?? rootPackage.devDependencies?.playwright ?? rootPackage.devDependencies?.["@playwright/test"],
    "playwright"
  );
  const packageJson = {
    name: "aiboard-runner-v2",
    version: rootPackage.version,
    private: true,
    license: rootPackage.license,
    type: "module",
    engines: { node: ">=24.18.0" },
    scripts: {
      start: "tsx src/cli.ts",
      "setup:browser": "playwright install chromium",
    },
    dependencies: {
      playwright: playwrightVersion,
      tsx: tsxVersion,
    },
  };
  zip.file("package.json", `${JSON.stringify(packageJson, null, 2)}\n`, { date: new Date(0), createFolders: false });
  zip.file("LICENSE", normalizedTextFile(path.join(root, "LICENSE")), { date: new Date(0), createFolders: false });
  zip.file("README.md", `# AI Board Runner V2

Runner V2 is the native process required by AI Board Build mode.

## Prerequisites

- Node.js 24.18.0 or newer
- Git installed and available on PATH

## Install and start

1. Extract \`aiboard-runner-v2.zip\` to a directory on your computer.
2. Open a terminal in the extracted directory.
3. Install the package and Chromium:

   \`\`\`powershell
   npm install
   npm run setup:browser
   \`\`\`

4. Start Runner V2. The state directory must be outside the project directory:

   \`\`\`powershell
   npm start -- --project C:\\path\\to\\project --state-dir C:\\path\\to\\aiboard-state --port 8787
   \`\`\`

Runner V2 prints its localhost URL and control token. Paste both into AI Board Build setup, then test the connection.
`, { date: new Date(0), createFolders: false });

  const destination = path.join(publicDirectory, "aiboard-runner-v2.zip");
  fs.writeFileSync(destination, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  }));
  console.log(`Published ${path.relative(root, destination)}.`);
}

async function publishAccountRunner() {
  if (!fs.existsSync(accountRunnerSource) || !fs.existsSync(accountSdkSource)) return;
  const sdkVersion = pinnedVersion(rootPackage.dependencies?.["@github/copilot-sdk"], "@github/copilot-sdk");
  const zip = new JSZip();
  zip.file("account-provider-runner.mjs", archiveFileContent(accountRunnerSource), { date: new Date(0), createFolders: false });
  zip.file("account-provider-copilot-sdk.mjs", archiveFileContent(accountSdkSource), { date: new Date(0), createFolders: false });
  zip.file("package.json", `${JSON.stringify({
    name: "aiboard-account-provider-runner",
    version: rootPackage.version,
    private: true,
    license: rootPackage.license,
    type: "module",
    engines: { node: ">=20.19.0" },
    scripts: { start: "node account-provider-runner.mjs" },
    dependencies: { "@github/copilot-sdk": sdkVersion },
  }, null, 2)}\n`, { date: new Date(0), createFolders: false });
  zip.file("README.md", `# AI Board account-provider runner

This package runs the local account bridge for ChatGPT Plus/Pro, GitHub Copilot,
and NVIDIA NIM. The GitHub Copilot discussion transport uses the official
Copilot SDK and its built-in web_search/web_fetch tools.

## Install and start

1. Extract this ZIP to a directory.
2. Open a terminal in that directory.
3. Install the runner dependencies:

   \`\`\`powershell
   npm install
   \`\`\`

4. Start the runner:

   \`\`\`powershell
   npm start
   \`\`\`

The runner prints the local URL and token to paste into AI Board Settings.
`, { date: new Date(0), createFolders: false });
  zip.file("LICENSE", normalizedTextFile(path.join(root, "LICENSE")), { date: new Date(0), createFolders: false });
  const destination = path.join(publicDirectory, "aiboard-account-provider-runner.zip");
  fs.writeFileSync(destination, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  }));
  console.log(`Published ${path.relative(root, destination)}.`);
}

fs.mkdirSync(publicDirectory, { recursive: true });
for (const retired of ["runner.mjs", "runner-manifest.json"]) {
  fs.rmSync(path.join(publicDirectory, retired), { force: true });
}
for (const [source, destination] of downloads) {
  if (!fs.existsSync(source)) continue;
  fs.copyFileSync(source, destination);
  console.log(`Published ${path.relative(root, destination)}.`);
}
await publishAccountRunner();
await publishNativeRunner();

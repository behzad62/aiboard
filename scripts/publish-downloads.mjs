// Publish the browser-downloadable transports and the standalone Runner V2
// source distribution used by hosted AI Board deployments.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import {
  PINNED_RJS_RUNNER_COMMIT,
  verifyPinnedRjsRunnerSource,
} from "./pinned-rjs-runner-source.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, "..");
const cliArgs = process.argv.slice(2);
function singleOption(name) {
  const positions = cliArgs.flatMap((value, index) => value === name ? [index] : []);
  if (positions.length > 1) throw new Error(`publish-downloads ${name} may be specified only once.`);
  if (!positions.length) return undefined;
  const value = cliArgs[positions[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`publish-downloads ${name} requires a value.`);
  return value;
}
for (const value of cliArgs.filter((item) => item.startsWith("--"))) {
  if (!["--output-dir", "--only"].includes(value)) throw new Error(`Unknown publish-downloads option: ${value}`);
}
const outputDirectoryOption = singleOption("--output-dir");
const only = singleOption("--only");
if (only && only !== "rjs-workbench") throw new Error(`Unknown publish-downloads selector: ${only}`);
if (only && !outputDirectoryOption) throw new Error("publish-downloads --only requires --output-dir.");
const publicDirectory = outputDirectoryOption
  ? path.resolve(outputDirectoryOption)
  : path.join(root, "public");
const runnerDirectory = path.join(root, "runner-v2");
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const accountRunnerSource = path.join(root, "lib", "account-provider-runner.mjs");
const accountSdkSource = path.join(root, "lib", "account-provider-copilot-sdk.mjs");
const downloads = [
  [accountRunnerSource, path.join(publicDirectory, "account-provider-runner.mjs")],
  [path.join(scripts, "bench-runner.mjs"), path.join(publicDirectory, "bench-runner.mjs")],
  [path.join(scripts, "workbench-rjs-support.mjs"), path.join(publicDirectory, "workbench-rjs-support.mjs")],
  [path.join(scripts, "workbench-rjs-verifier-adapter.mjs"), path.join(publicDirectory, "workbench-rjs-verifier-adapter.mjs")],
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
  return [".ts", ".mts", ".mjs", ".ps1", ".md"].includes(path.extname(source).toLowerCase())
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

function nativeRunnerPackageJson() {
  const runnerPackage = JSON.parse(fs.readFileSync(path.join(runnerDirectory, "package.json"), "utf8"));
  const tsxVersion = pinnedVersion(rootPackage.devDependencies?.tsx, "tsx");
  const typescriptVersion = pinnedVersion(
    rootPackage.devDependencies?.typescript ?? rootPackage.dependencies?.typescript,
    "typescript"
  );
  const playwrightVersion = pinnedVersion(
    rootPackage.dependencies?.playwright ?? rootPackage.devDependencies?.playwright ?? rootPackage.devDependencies?.["@playwright/test"],
    "playwright"
  );
  return {
    name: "aiboard-runner-v2",
    version: rootPackage.version,
    private: true,
    license: rootPackage.license,
    type: "module",
    engines: runnerPackage.engines,
    bin: runnerPackage.bin,
    scripts: {
      start: "tsx src/cli.ts --",
      "setup:browser": "playwright install chromium",
    },
    ...(runnerPackage.optionalDependencies ? { optionalDependencies: runnerPackage.optionalDependencies } : {}),
    dependencies: {
      playwright: playwrightVersion,
      tsx: tsxVersion,
      typescript: typescriptVersion,
    },
  };
}

const nativeRunnerReadme = `# AI Board Runner V2

Runner V2 is the native process required by AI Board Build mode.

## Prerequisites

- Node.js 24.x
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

5. Optional flags can be passed in:

   \`\`\`powershell
   npm start -- --project C:\\path\\to\\project --state-dir C:\\path\\to\\aiboard-state --allow-origin https://aiboard.me
   \`\`\`

Default behavior already allows \`https://aiboard.me\` and \`https://www.aiboard.me\`.
Run \`npm start -- --help\` to list all options.

Runner V2 prints its localhost URL and control token. Paste both into AI Board Build setup, then test the connection.
`;

function addNativeRunnerFiles(zip, archiveRoot = "") {
  const cli = path.join(runnerDirectory, "src", "cli.ts");
  const skills = path.join(runnerDirectory, "skills");
  if (!fs.existsSync(cli)) {
    throw new Error("Cannot publish Runner V2: missing runner-v2/src/cli.ts.");
  }

  const archivePath = (file) => path.posix.join(archiveRoot, file);
  addDirectory(zip, path.join(runnerDirectory, "src"), archivePath("src"));
  addDirectory(zip, path.join(runnerDirectory, "bin"), archivePath("bin"));
  addDirectory(zip, skills, archivePath("skills"));
  zip.file(archivePath("package.json"), `${JSON.stringify(nativeRunnerPackageJson(), null, 2)}\n`, {
    date: new Date(0),
    createFolders: false,
  });
  zip.file(archivePath("LICENSE"), normalizedTextFile(path.join(root, "LICENSE")), {
    date: new Date(0),
    createFolders: false,
  });
  zip.file(archivePath("README.md"), nativeRunnerReadme, {
    date: new Date(0),
    createFolders: false,
  });
}

async function writeZip(zip, destination) {
  fs.writeFileSync(destination, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  }));
  console.log(`Published ${path.relative(root, destination)}.`);
}

async function publishNativeRunner() {
  const zip = new JSZip();
  addNativeRunnerFiles(zip);

  const destination = path.join(publicDirectory, "aiboard-runner-v2.zip");
  await writeZip(zip, destination);
}

async function publishWorkBenchRunner() {
  const zip = new JSZip();
  for (const name of ["bench-runner.mjs", "workbench-rjs-support.mjs", "workbench-rjs-verifier-adapter.mjs"]) {
    zip.file(name, archiveFileContent(path.join(scripts, name)), {
      date: new Date(0),
      createFolders: false,
    });
  }
  addNativeRunnerFiles(zip, "aiboard-runner-v2");
  zip.file("README.md", `# AI Board WorkBench runner bundle

This bundle includes the Bench Runner and its managed Runner V2 source.

## Prerequisites

- Node.js 24.x
- Git installed and available on PATH

## Install and start

1. Extract \`aiboard-workbench-runner.zip\`.
2. Open PowerShell in the extracted directory.
3. Install Runner V2 and its Chromium browser:

   \`\`\`powershell
   Set-Location .\\aiboard-runner-v2
   npm install
   npm run setup:browser
   Set-Location ..
   \`\`\`

4. Start the Bench Runner:

   \`\`\`powershell
   node .\\bench-runner.mjs
   \`\`\`

The startup banner prints the localhost URL, token, and managed Runner V2 readiness.
Paste the URL and token into Benchmark -> WorkBench. Keep both bundled paths together
so the Bench Runner can discover \`aiboard-runner-v2\` automatically.
`, { date: new Date(0), createFolders: false });

  await writeZip(zip, path.join(publicDirectory, "aiboard-workbench-runner.zip"));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function pinnedBlob(objectId) {
  return execFileSync("git", ["-C", root, "cat-file", "blob", objectId], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function publishRjsWorkBenchRunner() {
  const identity = await import(`${pathToFileURL(path.join(root, "benchmarks", "recoverable-job-service", "private", "identity.mjs")).href}?bundle=${Date.now()}`);
  const evaluator = await import(`${pathToFileURL(path.join(root, "benchmarks", "recoverable-job-service", "private", "evaluator.mjs")).href}?bundle=${Date.now()}`);
  const contractPaths = validateRjsIdentityPaths(identity.contractPaths, "contractPaths");
  const suitePaths = validateRjsIdentityPaths(identity.suitePaths, "suitePaths");
  const allRjsPaths = [...contractPaths, ...suitePaths];
  if (new Set(allRjsPaths).size !== allRjsPaths.length) {
    throw new Error("Recoverable Job Service identity contains duplicate paths.");
  }
  const hashes = await identity.scoreInputHashes();
  const runnerRecords = verifyPinnedRjsRunnerSource(root);
  const entries = new Map();
  for (const record of runnerRecords) entries.set(record.path, pinnedBlob(record.objectId));
  for (const relativePath of allRjsPaths) {
    const source = path.join(root, "benchmarks", "recoverable-job-service", ...relativePath.split("/"));
    entries.set(`benchmarks/recoverable-job-service/${relativePath}`, fs.readFileSync(source));
  }
  const trustedScripts = [
    "scripts/bench-runner.mjs",
    "scripts/workbench-rjs-support.mjs",
    "scripts/workbench-rjs-verifier-adapter.mjs",
  ];
  for (const relativePath of trustedScripts) {
    entries.set(relativePath, Buffer.from(normalizedTextFile(path.join(root, ...relativePath.split("/")))));
  }
  const bundleRoot = path.join(root, "benchmarks", "recoverable-job-service", "bundle");
  const packageBytes = Buffer.from(normalizedTextFile(path.join(bundleRoot, "package.json")));
  const lockBytes = Buffer.from(normalizedTextFile(path.join(bundleRoot, "package-lock.json")));
  entries.set("package.json", packageBytes);
  entries.set("package-lock.json", lockBytes);
  entries.set("LICENSE", Buffer.from(normalizedTextFile(path.join(root, "LICENSE"))));
  entries.set("README.md", Buffer.from(`# AI Board Recoverable Job Service WorkBench runner\n\nThis self-contained local package runs the Recoverable Job Service benchmark with its exact trusted runtime and accepted Runner V2 source. Model-driven runs require Windows and Node.js 24.18.0 because the accepted Runner uses Windows Job Objects. The standalone evaluator also runs on Linux.\n\n1. Run \`npm ci\`.\n2. Run \`npm run setup:browser\`.\n3. Run \`npm start\`.\n4. Paste the printed local URL and token into AI Board.\n\nThe private evaluator is trusted against benchmark agents, but it is present on and inspectable by the machine owner. Give models only the candidate-visible files shown in AI Board; do not provide the private evaluator or controls as solution material.\n`));
  const archiveAllowlist = [...entries.keys()].sort();
  const manifest = {
    schemaVersion: 1,
    archive: "aiboard-rjs-workbench-runner.zip",
    acceptedRunnerCommit: PINNED_RJS_RUNNER_COMMIT,
    runner: runnerRecords.map((record) => ({
      archivePath: record.path,
      objectId: record.objectId,
      mode: record.mode,
    })),
    recoverableJobService: {
      profile: evaluator.PROFILE,
      contractVersion: evaluator.CONTRACT_VERSION,
      suiteVersion: evaluator.SUITE_VERSION,
      contractHash: hashes.contractHash,
      suiteHash: hashes.suiteHash,
      contractPaths,
      suitePaths,
    },
    trustedScriptHashes: Object.fromEntries(trustedScripts.map((relativePath) => [
      relativePath,
      sha256(entries.get(relativePath)),
    ])),
    packageLockHash: sha256(lockBytes),
    archiveAllowlist,
  };
  entries.set("bundle-manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const zip = new JSZip();
  for (const archivePath of [...entries.keys()].sort()) {
    const runnerMode = runnerRecords.find((record) => record.path === archivePath)?.mode;
    zip.file(archivePath, entries.get(archivePath), {
      date: new Date(0),
      createFolders: false,
      unixPermissions: runnerMode === "100755" ? 0o100755 : 0o100644,
    });
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const destination = path.join(publicDirectory, "aiboard-rjs-workbench-runner.zip");
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, destination);
  console.log(`Published ${path.relative(root, destination)}.`);
}

function validateRjsIdentityPaths(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Recoverable Job Service ${label} is invalid.`);
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !/^(?:public|private)\/[A-Za-z0-9._/-]+$/.test(entry) ||
      entry.includes("..") ||
      path.posix.normalize(entry) !== entry
    ) throw new Error(`Recoverable Job Service ${label} contains an out-of-root path.`);
    return entry;
  });
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
if (only === "rjs-workbench") {
  await publishRjsWorkBenchRunner();
} else {
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
  await publishWorkBenchRunner();
  await publishRjsWorkBenchRunner();
}

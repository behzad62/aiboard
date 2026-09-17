import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const runnerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(runnerRoot, "..");
const publisher = join(repoRoot, "scripts", "publish-downloads.mjs");
const expectedEngine = ">=22.13.0 <23 || >=24.0.0 <25";

test("account-provider publishing stays dependency-isolated from Runner V2 optional dependencies", () => {
  const source = readFileSync(publisher, "utf8");
  const start = source.indexOf("async function publishAccountRunner()");
  const end = source.indexOf("async function", start + 1);
  assert.notEqual(start, -1, "Account-provider publisher is missing.");
  const section = source.slice(start, end === -1 ? source.length : end);
  assert.doesNotMatch(section, /runnerPackage\.optionalDependencies/);
});
test("published Runner normalizes script line endings for cross-platform reproducibility", async () => {
  const temp = mkdtempSync(join(tmpdir(), "aiboard-runner-line-endings-"));
  try {
    execFileSync(process.execPath, [publisher, "--output-dir", temp], { cwd: repoRoot, stdio: "pipe" });
    const zip = await JSZip.loadAsync(readFileSync(join(temp, "aiboard-runner-v2.zip")));
    const archived = await required(zip, "src/managed-process-supervisor.mjs").async("string");
    const source = readFileSync(join(runnerRoot, "src", "managed-process-supervisor.mjs"), "utf8")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");
    assert.equal(archived, source);
    assert.doesNotMatch(archived, /\r/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("published Runner archives are byte-for-byte reproducible", () => {
  const temp = mkdtempSync(join(tmpdir(), "aiboard-runner-reproducible-"));
  try {
    const first = join(temp, "first");
    const second = join(temp, "second");
    execFileSync(process.execPath, [publisher, "--output-dir", first], { cwd: repoRoot, stdio: "pipe" });
    execFileSync(process.execPath, [publisher, "--output-dir", second], { cwd: repoRoot, stdio: "pipe" });
    const archives = readdirSync(first).filter((name) => name.endsWith(".zip")).sort();
    assert.deepEqual(archives, [
      "aiboard-account-provider-runner.zip",
      "aiboard-runner-v2.zip",
      "aiboard-workbench-runner.zip",
    ]);
    assert.deepEqual(readdirSync(second).filter((name) => name.endsWith(".zip")).sort(), archives);
    for (const archive of archives) {
      assert.equal(readFileSync(join(first, archive)).equals(readFileSync(join(second, archive))), true,
        `${archive} must be reproducible byte-for-byte.`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("cross-host package hash verifier rejects a mismatched host archive", () => {
  const temp = mkdtempSync(join(tmpdir(), "aiboard-runner-cross-host-hashes-"));
  const archiveDir = join(temp, "archives");
  const reportsDir = join(temp, "reports");
  const hashTool = join(repoRoot, "scripts", "runner-v2-package-hashes.mjs");
  try {
    mkdirSync(reportsDir, { recursive: true });
    execFileSync(process.execPath, [publisher, "--output-dir", archiveDir], { cwd: repoRoot, stdio: "pipe" });
    for (const label of ["windows-latest", "ubuntu-latest", "macos-latest"]) {
      execFileSync(process.execPath, [hashTool, "write", "--input-dir", archiveDir, "--output", join(reportsDir, `${label}.json`), "--label", label], { cwd: repoRoot, stdio: "pipe" });
    }
    const compareArgs = [hashTool, "compare", "--input-dir", reportsDir, "--expected-labels", "windows-latest,ubuntu-latest,macos-latest"];
    execFileSync(process.execPath, compareArgs, { cwd: repoRoot, stdio: "pipe" });
    const macPath = join(reportsDir, "macos-latest.json");
    const mac = JSON.parse(readFileSync(macPath, "utf8")) as { archives: Record<string, { sha256: string; bytes: number }> };
    mac.archives["aiboard-runner-v2.zip"]!.sha256 = "0".repeat(64);
    writeFileSync(macPath, `${JSON.stringify(mac, null, 2)}\n`);
    const mismatch = spawnSync(process.execPath, compareArgs, { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(mismatch.status, 0, "Cross-host verifier must reject a hash mismatch.");
    assert.match(mismatch.stderr, /differs between/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("published Runner archive contains the complete runtime and preserves installed package contracts", async () => {
  const temp = mkdtempSync(join(tmpdir(), "aiboard-runner-package-parity-"));
  try {
    execFileSync(process.execPath, [publisher, "--output-dir", temp], { cwd: repoRoot, stdio: "pipe" });
    const zip = await JSZip.loadAsync(readFileSync(join(temp, "aiboard-runner-v2.zip")));
    const packaged = JSON.parse(await required(zip, "package.json").async("string")) as {
      engines?: { node?: string };
      optionalDependencies?: Record<string, string>;
      bin?: Record<string, string>;
    };
    const source = JSON.parse(readFileSync(join(runnerRoot, "package.json"), "utf8")) as typeof packaged;
    assert.equal(packaged.engines?.node, expectedEngine);
    assert.equal(source.engines?.node, expectedEngine);
    assert.deepEqual(packaged.optionalDependencies, source.optionalDependencies);
    assert.deepEqual(packaged.bin, source.bin, "Installed Runner entrypoints must match the source package.");

    const expectedRuntime = archiveFiles(join(runnerRoot, "src"), "src");
    const expectedBin = archiveFiles(join(runnerRoot, "bin"), "bin");
    const expectedSkills = archiveFiles(join(runnerRoot, "skills"), "skills");
    const actualFiles = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir).sort();
    assert.deepEqual(actualFiles.filter((name) => name.startsWith("src/")), expectedRuntime);
    assert.deepEqual(actualFiles.filter((name) => name.startsWith("bin/")), expectedBin);
    assert.deepEqual(actualFiles.filter((name) => name.startsWith("skills/")), expectedSkills);
    assert.equal(actualFiles.some((name) => name.startsWith("test/") || name.startsWith(".github/") || name.startsWith(".superpowers/")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function required(zip: JSZip, name: string): JSZip.JSZipObject {
  const entry = zip.file(name);
  assert.ok(entry, `Missing ${name} from Runner archive.`);
  return entry;
}

function archiveFiles(root: string, prefix: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return archiveFiles(path, `${prefix}/${entry.name}`);
    return entry.isFile() ? [`${prefix}/${relative(root, path).replaceAll("\\", "/")}`] : [];
  }).sort();
}


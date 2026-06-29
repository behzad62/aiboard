/* Static deploy runner artifact checks (run after npm run build). */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
const publicAccountRunner = "public/account-provider-runner.mjs";
const exportedAccountRunner = "out/account-provider-runner.mjs";
const publicRunner = "public/runner.mjs";
const exportedRunner = "out/runner.mjs";
const publicManifest = "public/runner-manifest.json";
const exportedManifest = "out/runner-manifest.json";

for (const path of [
  publicAccountRunner,
  exportedAccountRunner,
  publicRunner,
  exportedRunner,
  publicManifest,
  exportedManifest,
]) {
  check(`${path} exists`, existsSync(path));
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

if (existsSync(exportedRunner) && existsSync(exportedManifest)) {
  const runner = read(exportedRunner);
  const manifest = JSON.parse(read(exportedManifest)) as {
    version?: unknown;
    sha256?: unknown;
    url?: unknown;
  };
  const fileVersion = Number((runner.match(/const VERSION = (\d+)/) ?? [])[1] ?? 0);
  check("exported runner manifest url points at download", manifest.url === "/runner.mjs", manifest);
  check(
    "exported runner manifest version matches file",
    manifest.version === fileVersion && fileVersion > 0,
    { manifestVersion: manifest.version, fileVersion }
  );
  check("exported runner manifest sha256 matches file", manifest.sha256 === sha256(runner));
}

if (existsSync(exportedRunner)) {
  check("exported runner is valid JavaScript", nodeCheck(exportedRunner));
}
if (existsSync(exportedAccountRunner)) {
  check("exported account runner is valid JavaScript", nodeCheck(exportedAccountRunner));
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

/* Static deploy runner artifact checks (run after npm run build). */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

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

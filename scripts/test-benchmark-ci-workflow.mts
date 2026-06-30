/* Benchmark CI workflow checks (run: npx tsx scripts/test-benchmark-ci-workflow.mts) */
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const workflowPath = ".github/workflows/benchmark-tests.yml";
check("benchmark CI workflow exists", existsSync(workflowPath), workflowPath);

const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";

for (const expected of [
  "npm ci",
  "npm run copy-runner",
  "npm run test:certified",
  "npm run test:benchmark",
  "npm run build",
  "actions/upload-artifact",
]) {
  check(`benchmark CI workflow includes ${expected}`, workflow.includes(expected), {
    workflowPath,
  });
}

check(
  "benchmark CI runs on pull requests and main pushes",
  /pull_request:/.test(workflow) && /push:[\s\S]*branches:\s*\[[^\]]*main/.test(workflow),
  workflow
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

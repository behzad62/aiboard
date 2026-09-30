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
const acquireCommand = 'node scripts/pinned-rjs-runner-source.mjs --acquire --remote origin --expected-repository "$GITHUB_REPOSITORY" --expected-server "$GITHUB_SERVER_URL"';
check("benchmark CI validates the pinned Windows runner and Linux evaluator",
  /os: \[ubuntu-latest, windows-latest\]/.test(workflow));
check("cross-platform pinned source acquisition uses the declared Bash syntax",
  /name: Acquire pinned Recoverable Job Service Runner source\s+shell: bash\s+run:/.test(workflow));
const setupNodeIndex = workflow.indexOf("actions/setup-node@v4");
const acquireIndex = workflow.indexOf(acquireCommand);
const installIndex = workflow.indexOf("npm ci");
const publishIndex = workflow.indexOf("npm run publish-downloads");
const portableWorkflow = readFileSync(".github/workflows/runner-v2-portable-execution.yml", "utf8");
for (const job of ["portable-contract", "package-gate"]) {
  const block = portableWorkflow.split(`  ${job}:`)[1]?.split(/\n  [a-z][a-z-]*:/)[0] ?? "";
  check(`${job} acquires the pinned Runner before package tests`,
    block.includes(acquireCommand) && block.indexOf(acquireCommand) < block.indexOf("npm ci"));
}

check(
  "benchmark CI acquires the pinned RJS Runner exactly once before install and publication",
  acquireIndex > setupNodeIndex && acquireIndex < installIndex && acquireIndex < publishIndex &&
    workflow.indexOf(acquireCommand, acquireIndex + 1) === -1,
  { setupNodeIndex, acquireIndex, installIndex, publishIndex }
);

check(
  "benchmark CI certifies only Node 24.x",
  /node-version:\s*\[24\.(?:x|\d+\.\d+)\]/.test(workflow) && !/22\.x/.test(workflow),
  workflow
);

for (const expected of [
  "npm ci",
  "npm run publish-downloads",
  "npm run test:certified",
  "npm run test:benchmark",
  "npm run test:benchmark:recoverable-job-service",
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

check(
  "benchmark CI uses the exact supported Node 24.18.0 RJS runtime",
  /node-version:\s*\[[^\]]*24\.18\.0[^\]]*\]/.test(workflow),
  workflow
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

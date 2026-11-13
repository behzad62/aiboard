/* Benchmark CI workflow checks (run: npx tsx scripts/test-benchmark-ci-workflow.mts) */
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { assignShards, expandScript } from "./ci-npm-script-shard.mjs";

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
const setupNodeIndex = workflow.indexOf("actions/setup-node@v7");
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
  "scripts/ci-npm-script-shard.mjs test:benchmark --shard",
  "npm run test:benchmark:rjs-qualification",
  "npm run build",
  "actions/upload-artifact",
]) {
  check(`benchmark CI workflow includes ${expected}`, workflow.includes(expected), {
    workflowPath,
  });
}
check("benchmark CI does not replay the certified groups already included by test:benchmark",
  !workflow.includes("npm run test:certified"));

check(
  "benchmark CI runs on pull requests and main pushes",
  /pull_request:/.test(workflow) && /push:[\s\S]*branches:\s*\[[^\]]*main/.test(workflow),
  workflow
);

check("benchmark CI skips Runner-only changes on pull requests and main pushes, and runs nightly to catch what they break",
  workflow.split('- "runner-v2/**"').length === 3 && /schedule:\s+- cron:/.test(workflow));
// Windows runs suite-1..N as N shards; Ubuntu runs only suite-1, as one shard of 1 (the whole suite).
const parts = workflow.match(/part: \[([^\]]*)\]/)?.[1]?.split(",").map((part) => part.trim()) ?? [];
const suiteShards = parts.filter((part) => part.startsWith("suite-"));
const windowsShardCount = Number(workflow.match(/SHARD_COUNT: \$\{\{ runner\.os == 'Windows' && '(\d+)' \|\| '1' \}\}/)?.[1]);
const ubuntuExcluded = [...workflow.matchAll(/- os: ubuntu-latest\s+part: (suite-\d+)/g)].map((match) => match[1]);
check("benchmark CI runs the suite shards and the qualification half in parallel jobs",
  parts.includes("qualification") && suiteShards.length > 1 && windowsShardCount === suiteShards.length &&
    suiteShards.every((part, index) => part === `suite-${index + 1}`) &&
    JSON.stringify(ubuntuExcluded) === JSON.stringify(suiteShards.slice(1)) &&
    !/- os: windows-latest\s+part: suite-/.test(workflow) &&
    workflow.includes('--shard "${SHARD#suite-}/${SHARD_COUNT}"') &&
    /if: startsWith\(matrix\.part, 'suite-'\)[\s\S]*ci-npm-script-shard\.mjs test:benchmark --shard[^\n]*2>&1/.test(workflow),
  { parts, windowsShardCount, ubuntuExcluded });
const benchmarkCommands = expandScript(JSON.parse(readFileSync("package.json", "utf8")).scripts, "test:benchmark");
for (const count of [windowsShardCount, 1]) {
  const sharded = assignShards(benchmarkCommands, count).flatMap((shard) => shard.commands);
  check(`${count} suite shard(s) together run every test:benchmark command exactly once`,
    benchmarkCommands.length > 50 && sharded.length === benchmarkCommands.length &&
      benchmarkCommands.every((entry) => sharded.filter((other) => other === entry).length === 1),
    { commands: benchmarkCommands.length, sharded: sharded.length });
}
check("benchmark CI publishes the downloads once per job, not again through the prebuild hook",
  workflow.includes("npm run build --ignore-scripts"));
check("benchmark CI installs Linux system packages for the browser, never Windows Server features",
  workflow.includes('if [ "$RUNNER_OS" = "Linux" ]; then npx playwright install --with-deps chromium; else npx playwright install chromium; fi'));

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

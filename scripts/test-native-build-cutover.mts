import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const engine = readFileSync("lib/client/engine.ts", "utf8");
const runnerSetup = readFileSync("components/RunnerSetup.tsx", "utf8");
const runnerGuide = readFileSync("app/runner-guide/page.tsx", "utf8");
const nativeBuildEngine = readFileSync("lib/client/native-build-engine.ts", "utf8");
const discussionClient = readFileSync("app/discussion/discussion-client.tsx", "utf8");
const workBenchAdapter = readFileSync("lib/benchmark/workbench/build-adapter.ts", "utf8");
const certification = readFileSync("lib/benchmark/certified/certification.ts", "utf8");

assert.match(engine, /import\("\.\/native-build-engine"\)/);
assert.doesNotMatch(engine, /import\("\.\/build-engine"\)/);
assert.equal(packageJson.scripts.predev, "npm run publish-downloads");
assert.equal(packageJson.scripts.prebuild, "npm run publish-downloads");
assert.equal("copy-runner" in packageJson.scripts, false);
assert.doesNotMatch(runnerSetup, /@\/lib\/client\/runner["']/);
assert.match(runnerSetup, /Node\.js[\s\S]*24\.18\.0/);
assert.match(runnerSetup, /24\.18\.0 or\s+newer/);
const runnerDownloadLink = /<(?:a|Link)\b(?=[^>]*\bhref=["']\/aiboard-runner-v2\.zip["'])(?=[^>]*\bdownload(?:\s|=|>))[^>]*>/s;
assert.deepEqual(
  [
    ["components/RunnerSetup.tsx", runnerSetup],
    ["app/runner-guide/page.tsx", runnerGuide],
  ]
    .filter(([, source]) => !runnerDownloadLink.test(source))
    .map(([path]) => path),
  [],
  "both Runner setup surfaces must link to /aiboard-runner-v2.zip with the download attribute"
);
assert.doesNotMatch(nativeBuildEngine, /stepNativeBuild/);
assert.doesNotMatch(nativeBuildEngine, /\/build\/step/);
assert.match(nativeBuildEngine, /effectiveNativeBuildPolicy/);
assert.match(nativeBuildEngine, /supportsNativeRunnerNodeVersion/);
assert.doesNotMatch(nativeBuildEngine, /function buildBudgets/);
assert.doesNotMatch(nativeBuildEngine, /health\.nodeVersion !== "24\.18\.0"/);
assert.match(
  discussionClient,
  /discussion\.mode === "build" &&\s*!discussion\.nativeBuildRunId &&\s*buildToolReviewReport/
);
assert.match(
  discussionClient,
  /discussion\.mode === "build" &&\s*!discussion\.nativeBuildRunId &&\s*buildStopReport/
);
assert.doesNotMatch(workBenchAdapter, /import\([^)]*legacy-build-engine/);
assert.doesNotMatch(certification, /legacy-build-engine/);

console.log("PASS native Build cutover");

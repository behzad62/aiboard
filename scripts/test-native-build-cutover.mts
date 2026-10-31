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
assert.match(runnerSetup, /NATIVE_RUNNER_NODE_POLICY_DESCRIPTION/);
assert.doesNotMatch(
  runnerSetup,
  /LTS release \(\$\{NATIVE_RUNNER_NODE_POLICY_DESCRIPTION\}/,
  "Runner setup must render the Node policy expression without a stray dollar sign"
);
assert.doesNotMatch(runnerSetup, /24\.18\.0/);
// Both Runner setup surfaces teach the signed one-line installers and `aiboard`, never the old ZIP + npm steps.
const installCommands = readFileSync("components/runner/RunnerInstallCommands.tsx", "utf8");
const runnerInstall = readFileSync("lib/runner-install.ts", "utf8");
assert.match(runnerInstall, /"irm https:\/\/aiboard\.me\/install\.ps1 \| iex"/);
assert.match(runnerInstall, /"curl -fsSL https:\/\/aiboard\.me\/install\.sh \| sh"/);
assert.match(installCommands, /RUNNER_INSTALL_WINDOWS[\s\S]*RUNNER_INSTALL_POSIX/);
for (const [path, source] of [["components/RunnerSetup.tsx", runnerSetup], ["app/runner-guide/page.tsx", runnerGuide]] as const) {
  assert.match(source, /<RunnerInstallCommands\b/, `${path} must show the one-line installers`);
  assert.match(source, /RUNNER_START_COMMAND/, `${path} must say to run aiboard`);
  assert.doesNotMatch(source, /aiboard-runner-v2\.zip|npm install|setup:browser|npm start -- --project|--state-dir/, `${path} must not show the old ZIP + npm steps`);
}
assert.doesNotMatch(nativeBuildEngine, /stepNativeBuild/);
assert.doesNotMatch(nativeBuildEngine, /\/build\/step/);
assert.match(nativeBuildEngine, /effectiveNativeBuildPolicy/);
assert.match(nativeBuildEngine, /supportsNativeRunnerNodeVersion/);
assert.doesNotMatch(nativeBuildEngine, /function buildBudgets/);
assert.doesNotMatch(nativeBuildEngine, /24\.18\.0/);
// Legacy browser-engine panels render only inside the Build workspace branch,
// and only for runs that never had a Runner V2 run id.
assert.match(discussionClient, /if \(discussion\.mode === "build"\) \{/);
assert.match(
  discussionClient,
  /!discussion\.nativeBuildRunId &&\s*buildToolReviewReport/
);
assert.match(
  discussionClient,
  /!discussion\.nativeBuildRunId &&\s*buildStopReport/
);
assert.doesNotMatch(workBenchAdapter, /import\([^)]*legacy-build-engine/);
assert.doesNotMatch(certification, /legacy-build-engine/);

console.log("PASS native Build cutover");

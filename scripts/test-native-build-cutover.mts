import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const engine = readFileSync("lib/client/engine.ts", "utf8");
const runnerSetup = readFileSync("components/RunnerSetup.tsx", "utf8");
const nativeBuildEngine = readFileSync("lib/client/native-build-engine.ts", "utf8");

assert.match(engine, /import\("\.\/native-build-engine"\)/);
assert.doesNotMatch(engine, /import\("\.\/build-engine"\)/);
assert.equal(packageJson.scripts.predev, "npm run publish-downloads");
assert.equal(packageJson.scripts.prebuild, "npm run publish-downloads");
assert.equal("copy-runner" in packageJson.scripts, false);
assert.doesNotMatch(runnerSetup, /@\/lib\/client\/runner["']/);
assert.match(runnerSetup, /Node\.js[\s\S]*24\.18\.0/);
assert.doesNotMatch(nativeBuildEngine, /stepNativeBuild/);
assert.doesNotMatch(nativeBuildEngine, /\/build\/step/);

console.log("PASS native Build cutover");

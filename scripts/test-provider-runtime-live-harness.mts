import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const script = "scripts/test-provider-runtime-live.mts";

function run(envPatch: NodeJS.ProcessEnv) {
  const env = { ...process.env, ...envPatch };
  const result = spawnSync(process.execPath, [tsxCli, script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error,
  };
}

const defaultRun = run({ AIBOARD_PROVIDER_RUNTIME_LIVE: "" });
assert.equal(defaultRun.error, undefined);
assert.equal(defaultRun.status, 0);
assert.match(defaultRun.output, /SKIP provider runtime live suite/i);
console.log("PASS live provider suite is inert without explicit opt-in");

const fakeHome = mkdtempSync(join(tmpdir(), "aiboard-provider-live-test-"));
try {
  const optedIn = run({
    AIBOARD_PROVIDER_RUNTIME_LIVE: "1",
    OPENROUTER_API_KEY: "",
    AIBOARD_STORE_PATH: "",
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  });
  assert.equal(optedIn.error, undefined);
  assert.equal(optedIn.status, 0, optedIn.output);
  assert.match(
    optedIn.output,
    /SKIP provider=openrouter transport=responses model=/i,
    "OpenRouter skip must record provider/model/transport",
  );
  assert.match(
    optedIn.output,
    /SKIP provider=github-copilot transport=copilot_sdk,runner_proxy model=/i,
    "Copilot skip must record provider/model/transport",
  );
  assert.match(optedIn.output, /no configured live providers/i);
  console.log("PASS opted-in live suite reports credential-aware provider/model/transport skips");
} finally {
  rmSync(fakeHome, { recursive: true, force: true });
}

console.log("PASS");
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const tests = [
  "scripts/test-provider-capability-contracts.mts",
  "scripts/test-provider-capability-resolution.mts",
  "scripts/test-provider-call-planner.mts",
  "scripts/test-provider-tool-loading.mts",
  "scripts/test-provider-tool-events.mts",
  "scripts/test-provider-artifacts.mts",
  "scripts/test-provider-call-preflight.mts",
  "scripts/test-provider-registry.mts",
  "scripts/test-provider-web-search.mts",
  "scripts/test-provider-native-tools.mts",
  "scripts/test-openai-tool-runtime.mts",
  "scripts/test-anthropic-tool-runtime.mts",
  "scripts/test-google-tool-runtime.mts",
  "scripts/test-xai-tool-runtime.mts",
  "scripts/test-meta-tool-runtime.mts",
  "scripts/test-openrouter-responses.mts",
  "scripts/test-openrouter-capability-upgrades.mts",
  "scripts/test-account-provider-runner-capabilities.mts",
  "scripts/test-account-runner-capability-planning.mts",
  "scripts/test-provider-capability-discovery.mts",
  "scripts/test-provider-model-discovery.mts",
  "scripts/test-openai-provider-settings.mts",
  "scripts/test-chatgpt-live-model-discovery.mts",
  "scripts/test-custom-provider-capabilities.mts",
  "scripts/test-custom-provider-capability-ui.tsx",
  "scripts/test-provider-capability-status.mts",
  "scripts/test-tool-runtime-readiness.mts",
  "scripts/test-provider-legacy-removal.mts",
  "scripts/test-provider-runtime-live-harness.mts",
  "scripts/test-account-provider-runner-package.mts",
] as const;

for (const test of tests) {
  console.log(`\n===== ${test} =====`);
  const result = spawnSync(process.execPath, [tsxCli, test], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nPASS provider runtime regression suite (${tests.length} credential-free checks)`);

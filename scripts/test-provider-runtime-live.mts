import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

if (process.env.AIBOARD_PROVIDER_RUNTIME_LIVE !== "1") {
  console.log("SKIP provider runtime live suite — set AIBOARD_PROVIDER_RUNTIME_LIVE=1 to opt in");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const liveChecks = [
  {
    name: "OpenRouter structured-output/provider drift smoke",
    script: "scripts/test-openrouter-structured-output-live.mts",
  },
  {
    name: "GitHub Copilot SDK/account-runner feature matrix",
    script: "scripts/test-account-provider-runner-copilot-all-live.mts",
  },
] as const;

let ran = 0;
for (const check of liveChecks) {
  console.log(`\n===== LIVE: ${check.name} =====`);
  const result = spawnSync(process.execPath, [tsxCli, check.script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  ran += 1;
}

console.log(`\nPASS provider runtime live harness completed ${ran} opt-in probe group(s); individual probes report SKIP when credentials/account state are absent.`);

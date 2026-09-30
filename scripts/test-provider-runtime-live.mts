import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

if (process.env.AIBOARD_PROVIDER_RUNTIME_LIVE !== "1") {
  console.log("SKIP provider runtime live suite — set AIBOARD_PROVIDER_RUNTIME_LIVE=1 to opt in");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const openRouterModels = (process.env.OPENROUTER_LIVE_MODELS ?? "z-ai/glm-5.2,minimax/minimax-m3")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

function hasCopilotAccountToken(): boolean {
  const authPath = join(homedir(), ".aiboard-account-provider-runner.json");
  if (!existsSync(authPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as {
      githubCopilot?: { access?: unknown };
    };
    return typeof parsed.githubCopilot?.access === "string" && parsed.githubCopilot.access.trim().length > 0;
  } catch {
    return false;
  }
}

const liveChecks = [
  {
    provider: "openrouter",
    transport: "responses",
    models: openRouterModels,
    configured: Boolean(process.env.OPENROUTER_API_KEY?.trim() || process.env.AIBOARD_STORE_PATH?.trim()),
    missingReason: "no OPENROUTER_API_KEY or AIBOARD_STORE_PATH",
    name: "OpenRouter structured-output/provider drift smoke",
    script: "scripts/test-openrouter-structured-output-live.mts",
  },
  {
    provider: "github-copilot",
    transport: "copilot_sdk,runner_proxy",
    models: ["gemini-3.5-flash", "gpt-5.4-mini"],
    configured: hasCopilotAccountToken(),
    missingReason: "no GitHub Copilot token in local account-runner auth",
    name: "GitHub Copilot SDK/account-runner feature matrix",
    script: "scripts/test-account-provider-runner-copilot-all-live.mts",
  },
] as const;

let ran = 0;
for (const check of liveChecks) {
  const modelLabel = check.models.join(",");
  if (!check.configured) {
    console.log(`SKIP provider=${check.provider} transport=${check.transport} model=${modelLabel} reason=${check.missingReason}`);
    continue;
  }

  console.log(`\n===== LIVE provider=${check.provider} transport=${check.transport} model=${modelLabel} =====`);
  console.log(check.name);
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

if (ran === 0) {
  console.log("SKIP provider runtime live suite — no configured live providers");
} else {
  console.log(`\nPASS provider runtime live harness completed ${ran} configured probe group(s).`);
}
/* Stress benchmark checks (run: npx tsx scripts/test-benchmark-stress.mts)
 * This standalone entrypoint is intentionally separate from package.json so agents
 * can run the new large-file/tool-use challenge checks without changing the main
 * benchmark test pipeline.
 */
import { spawnSync } from "node:child_process";

const scripts = [
  "scripts/test-toolreliability-stress-cases.mts",
  "scripts/test-workbench-v2-challenges.mts",
];
let failures = 0;
for (const script of scripts) {
  const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", script], {
    stdio: "inherit",
  });
  if (result.status !== 0) failures += 1;
}

process.exit(failures === 0 ? 0 : 1);

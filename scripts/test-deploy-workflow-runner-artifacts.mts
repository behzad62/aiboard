/* Deploy workflow runner-artifact guard (run: npx tsx scripts/test-deploy-workflow-runner-artifacts.mts) */
import { readFileSync } from "node:fs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const workflowPath = ".github/workflows/deploy-aiboard.yml";
const workflow = readFileSync(workflowPath, "utf8");

const copyRunnerIndex = workflow.indexOf("npm run copy-runner");
const buildIndex = workflow.indexOf("npm run build");
const verifyIndex = workflow.indexOf("npx tsx scripts/test-deploy-runner-artifacts.mts");
const uploadIndex = workflow.indexOf("appleboy/scp-action");

check("deploy workflow explicitly regenerates runner downloads", copyRunnerIndex >= 0, {
  workflowPath,
});
check(
  "deploy workflow regenerates runners before static build",
  copyRunnerIndex >= 0 && buildIndex >= 0 && copyRunnerIndex < buildIndex,
  { copyRunnerIndex, buildIndex }
);
check("deploy workflow verifies exported runner downloads", verifyIndex >= 0, {
  workflowPath,
});
check(
  "deploy workflow verifies runner downloads before upload",
  verifyIndex >= 0 && uploadIndex >= 0 && verifyIndex < uploadIndex,
  { verifyIndex, uploadIndex }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

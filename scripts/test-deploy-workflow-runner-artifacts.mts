/* Deploy workflow runner-artifact guard (run: npx tsx scripts/test-deploy-workflow-runner-artifacts.mts) */
import { readFileSync } from "node:fs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const workflowPath = ".github/workflows/deploy-aiboard.yml";
const workflow = readFileSync(workflowPath, "utf8");

const publishDownloadsIndex = workflow.indexOf("npm run publish-downloads");
const setupNodeIndex = workflow.indexOf("actions/setup-node@v4");
const installIndex = workflow.indexOf("npm ci");
const acquireCommand = 'node scripts/pinned-rjs-runner-source.mjs --acquire --remote origin --expected-repository "$GITHUB_REPOSITORY" --expected-server "$GITHUB_SERVER_URL"';
const acquireIndex = workflow.indexOf(acquireCommand);
const buildIndex = workflow.indexOf("npm run build");
const verifyIndex = workflow.indexOf("npx tsx scripts/test-deploy-runner-artifacts.mts");
const uploadIndex = workflow.indexOf("appleboy/scp-action");

check("deploy workflow explicitly publishes supported downloads", publishDownloadsIndex >= 0, {
  workflowPath,
});
check(
  "deploy workflow acquires the pinned RJS Runner exactly once before install and publication",
  acquireIndex > setupNodeIndex && acquireIndex < installIndex && acquireIndex < publishDownloadsIndex &&
    workflow.indexOf(acquireCommand, acquireIndex + 1) === -1,
  { setupNodeIndex, acquireIndex, installIndex, publishDownloadsIndex }
);
check(
  "deploy workflow publishes downloads before static build",
  publishDownloadsIndex >= 0 && buildIndex >= 0 && publishDownloadsIndex < buildIndex,
  { publishDownloadsIndex, buildIndex }
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

/** Build worker write-scope checks (run: npx tsx scripts/test-build-write-scope.mts) */
import {
  isSuspiciousBuildArtifactPath,
  isTaskWritePathAllowed,
  type BuildTask,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const testFixTask: BuildTask = {
  id: "T1",
  title: "Fix frontend contract test syntax corruption",
  instructions: "Fix the syntax error in the frontend contract test.",
  contextFiles: ["tests/frontend-contract.test.js"],
  outputPaths: ["tests/frontend-contract.test.js"],
  expectedOutputs: "tests/frontend-contract.test.js",
  status: "planned",
};

check(
  "task may write its declared output file",
  isTaskWritePathAllowed(testFixTask, "tests/frontend-contract.test.js"),
);
check(
  "task may not write arbitrary result artifacts",
  !isTaskWritePathAllowed(testFixTask, "actions/result"),
);
check(
  "actions/result is classified as a suspicious build artifact path",
  isSuspiciousBuildArtifactPath("actions/result"),
);
check(
  "declaring actions/result as an output still does not make it a project write target",
  !isTaskWritePathAllowed(
    { ...testFixTask, outputPaths: ["actions/result"], contextFiles: [] },
    "actions/result"
  ),
);

const contextOnlyTask: BuildTask = {
  id: "T2",
  title: "Patch existing config",
  instructions: "Patch the existing config.",
  contextFiles: ["package.json"],
  status: "planned",
};
check(
  "task without explicit outputs may patch a context file",
  isTaskWritePathAllowed(contextOnlyTask, "package.json"),
);

process.exit(failed === 0 ? 0 : 1);

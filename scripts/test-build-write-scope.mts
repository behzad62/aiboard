/** Build worker write-scope checks (run: npx tsx scripts/test-build-write-scope.mts) */
import {
  buildWorkerContextFileCharLimit,
  evaluateExistingFileRewrite,
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

const evidenceOnlyAuditTask: BuildTask = {
  id: "T-audit",
  title: "Audit current browser module shape",
  instructions: "Inspect src/game.js and report evidence only. Do not edit files.",
  kind: "audit",
  completionMode: "evidence",
  verificationPolicy: "architect",
  contextFiles: ["src/game.js", "index.html"],
  outputPaths: [],
  expectedOutputs: "Evidence-only audit; no file changes.",
  status: "fixing",
};
check(
  "evidence-only audit cannot mutate a context file without declared outputs",
  !isTaskWritePathAllowed(evidenceOnlyAuditTask, "src/game.js"),
);

const largeRewrite = evaluateExistingFileRewrite({
  path: "src/game.js",
  existingLength: 38_845,
  replacementLength: 63_916,
  writer: "worker",
});
check(
  "worker full-file rewrite of a large existing file is rejected even when it expands",
  largeRewrite.reject && largeRewrite.code === "large_existing_file_rewrite",
  largeRewrite,
);

const suspiciousShrink = evaluateExistingFileRewrite({
  path: "src/game.js",
  existingLength: 38_845,
  replacementLength: 1_500,
  writer: "worker",
});
check(
  "suspicious shrinking rewrite remains rejected",
  suspiciousShrink.reject && suspiciousShrink.code === "suspicious_rewrite",
  suspiciousShrink,
);

const explicitLargeRewrite = evaluateExistingFileRewrite({
  path: "src/generated.js",
  existingLength: 40_000,
  replacementLength: 44_000,
  writer: "worker",
  allowLargeRewrite: true,
});
check(
  "explicitly authorized large existing rewrite can pass",
  !explicitLargeRewrite.reject,
  explicitLargeRewrite,
);

const smallRewrite = evaluateExistingFileRewrite({
  path: "src/small.js",
  existingLength: 1_500,
  replacementLength: 2_200,
  writer: "worker",
});
check("small existing file rewrite can pass", !smallRewrite.reject, smallRewrite);

check(
  "worker context file sizing uses context capacity instead of a fixed 6K cap",
  buildWorkerContextFileCharLimit({ contextPackTokens: 32_000, fileCount: 1 }) > 60_000
);
check(
  "worker context file sizing caps broad multi-file fanout",
  buildWorkerContextFileCharLimit({ contextPackTokens: 32_000, fileCount: 8 }) <
    buildWorkerContextFileCharLimit({ contextPackTokens: 32_000, fileCount: 1 })
);

process.exit(failed === 0 ? 0 : 1);

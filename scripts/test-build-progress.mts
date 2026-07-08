/** Build progress tracking checks (run: npx tsx scripts/test-build-progress.mts) */
import {
  buildVerificationFailureTask,
  countTaskStatusTransitions,
  extractVerificationFailurePaths,
  fingerprintBuildFailure,
  hasMeaningfulBuildProgress,
  recordBuildFailure,
  shouldStopForNoProgress,
} from "../lib/orchestrator/build-progress";
import type { BuildTask } from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const first = fingerprintBuildFailure("npm run build", "src/app.ts(12,4): error TS2345: Bad type");
const second = fingerprintBuildFailure("npm run build", "src/app.ts(18,7): error TS2345: Bad type again");
check("typescript failures with same code fingerprint together", first === second, { first, second });

let counts: Record<string, number> = {};
counts = recordBuildFailure(counts, first);
counts = recordBuildFailure(counts, first);
counts = recordBuildFailure(counts, first);
check("same failure records count", counts[first] === 3, counts);
check("three same failures can stop", shouldStopForNoProgress({ repeatedFailureCount: 3, noProgressWaves: 0 }));
check("four no-progress waves can stop", shouldStopForNoProgress({ repeatedFailureCount: 0, noProgressWaves: 4 }));
check("file writes count as progress", hasMeaningfulBuildProgress({ filesWritten: 1, tasksAdvanced: 0, failureChanged: false, repoAdvanced: false }));
check("changed failure counts as progress", hasMeaningfulBuildProgress({ filesWritten: 0, tasksAdvanced: 0, failureChanged: true, repoAdvanced: false }));
check(
  "net-same fixing task does not count as a status transition",
  countTaskStatusTransitions(
    new Map([["T2", "fixing"]]),
    [{ id: "T2", status: "fixing" }]
  ) === 0
);
check(
  "fixing to done counts as a status transition",
  countTaskStatusTransitions(
    new Map([["T2", "fixing"]]),
    [{ id: "T2", status: "done" }]
  ) === 1
);

const verificationOutput = String.raw`
stdout:
> code-diagram-visualizer@1.0.0 check
stderr:
C:\Users\b_a_s\source\repos\CodeSketch\tests\frontend-contract.test.js:280
  assertFalse(categories.includes('.ts'), 'Should not use file extensions as categories');led in the finally block
                                                                                                     ^^^^^^^
SyntaxError: Unexpected token 'finally'
`;
const knownFiles = ["README.md", "tests/frontend-contract.test.js", "server/analyzer.js"];
const verificationPaths = extractVerificationFailurePaths(verificationOutput, knownFiles);
check(
  "verification failure output extracts project-relative failing file",
  verificationPaths.join(",") === "tests/frontend-contract.test.js",
  verificationPaths
);

const docsTask: BuildTask = {
  id: "T3",
  title: "Update docs",
  instructions: "Update README.md.",
  contextFiles: ["README.md"],
  outputPaths: ["README.md"],
  expectedOutputs: "README.md",
  status: "fixing",
};
const verificationTask = buildVerificationFailureTask({
  tasks: [docsTask],
  verifyCommand: "npm run check && npm test",
  verifyFeedback: verificationOutput,
  knownFiles,
});
check(
  "verification failure creates a scoped fix task for the failing file",
  verificationTask?.id === "T4" &&
    verificationTask.outputPaths?.join(",") === "tests/frontend-contract.test.js" &&
    verificationTask.contextFiles.join(",") === "tests/frontend-contract.test.js" &&
    /npm run check && npm test/.test(verificationTask.instructions),
  verificationTask
);

const verificationTaskWithGaps = buildVerificationFailureTask({
  tasks: [
    docsTask,
    {
      ...docsTask,
      id: "T13",
      title: "Previous final verification",
      outputPaths: ["README.md"],
      status: "done",
    },
  ],
  verifyCommand: "npm run check",
  verifyFeedback: verificationOutput,
  knownFiles,
});
check(
  "verification failure task uses the next numeric id after resumed task history",
  verificationTaskWithGaps?.id === "T14",
  verificationTaskWithGaps
);

const existingOwner: BuildTask = {
  ...docsTask,
  id: "T4",
  title: "Fix frontend contract test",
  contextFiles: ["tests/frontend-contract.test.js"],
  outputPaths: ["tests/frontend-contract.test.js"],
  status: "fixing",
};
check(
  "verification failure does not create duplicate task when an incomplete task already owns the file",
  buildVerificationFailureTask({
    tasks: [docsTask, existingOwner],
    verifyCommand: "npm run check && npm test",
    verifyFeedback: verificationOutput,
    knownFiles,
  }) === null
);

process.exit(failed === 0 ? 0 : 1);

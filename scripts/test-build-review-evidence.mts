/** Build review evidence contract checks (run: npx tsx scripts/test-build-review-evidence.mts) */
import { readFileSync } from "node:fs";
import {
  appendBuildTaskVerificationFact,
  discardSupersededTaskVerificationFacts,
  resolveBuildReviewContract,
  validateBuildReviewApprovals,
  type BuildTaskVerificationFact,
} from "../lib/orchestrator/build-review-evidence";
import { buildReviewContractRevisionPrompt, type BuildTask, type ReviewResult } from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const buildEngineSource = readFileSync(
  new URL("../lib/client/build-engine.ts", import.meta.url),
  "utf8"
);

const approved: ReviewResult = {
  taskId: "T1",
  specVerdict: "approve",
  qualityVerdict: "approve",
  specIssues: "",
  qualityIssues: "",
  fixInstructions: "",
};
const toolTask: BuildTask = {
  id: "T1",
  title: "Verify the application",
  instructions: "Run the declared checks.",
  contextFiles: [],
  outputPaths: ["src/app.ts"],
  status: "review",
  verificationPolicy: "tool",
  requiredToolActions: ["run"],
};
const fact = (
  input: Partial<BuildTaskVerificationFact> & Pick<BuildTaskVerificationFact, "taskId" | "wave" | "status">
): BuildTaskVerificationFact => ({
  at: "2026-07-10T10:00:00.000Z",
  action: "run",
  summary: "npm test exited successfully.",
  coveredPaths: ["src/app.ts"],
  source: "worker",
  ...input,
});

check(
  "tool approval without current evidence is rejected",
  validateBuildReviewApprovals({ tasks: [toolTask], results: [approved], facts: [], wave: 2 })
    .errors[0]?.code === "missing_task_verification"
);
check(
  "failed current verifier contradicts approval",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 2, status: "failed" })],
    wave: 2,
  }).errors[0]?.code === "failed_task_verification"
);
check(
  "architect policy does not require tool evidence",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, verificationPolicy: "architect" }],
    results: [approved],
    facts: [],
    wave: 2,
  }).valid
);
check(
  "phase-verification-covered tool task without declared actions passes through",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: undefined }],
    results: [approved],
    facts: [],
    wave: 2,
  }).valid
);
check(
  "phase-only coverage ignores unrelated failed and skipped worker runs",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: undefined }],
    results: [approved],
    facts: [
      fact({ taskId: "T1", wave: 2, status: "failed", source: "worker" }),
      fact({ taskId: "T1", wave: 2, status: "skipped", source: "worker" }),
    ],
    wave: 2,
  }).valid
);
check(
  "accepted project verifier requires its own passing fact",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: undefined }],
    results: [approved],
    facts: [
      fact({ taskId: "T1", wave: 2, status: "failed", source: "project_verifier" }),
    ],
    wave: 2,
  }).errors[0]?.code === "failed_task_verification"
);
check(
  "later exploratory worker run cannot override failed project verifier",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: undefined }],
    results: [approved],
    facts: [
      fact({
        taskId: "T1",
        wave: 2,
        status: "failed",
        source: "project_verifier",
        at: "2026-07-10T10:00:00.000Z",
      }),
      fact({
        taskId: "T1",
        wave: 2,
        status: "passed",
        source: "worker",
        at: "2026-07-10T10:01:00.000Z",
      }),
    ],
    wave: 2,
  }).errors[0]?.code === "failed_task_verification"
);
check(
  "accepted project verifier passes with its own current fact",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: undefined }],
    results: [approved],
    facts: [
      fact({ taskId: "T1", wave: 2, status: "passed", source: "project_verifier" }),
    ],
    wave: 2,
  }).valid
);
check(
  "legacy unprovenanced run cannot satisfy an explicit required run",
  !validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [
      fact({ taskId: "T1", wave: 2, status: "passed", source: undefined }),
    ],
    wave: 2,
  }).valid
);
check(
  "stale-wave evidence is rejected explicitly",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 1, status: "passed" })],
    wave: 2,
  }).errors[0]?.code === "stale_task_verification"
);
check(
  "current passing evidence permits approval",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 2, status: "passed" })],
    wave: 2,
  }).valid
);
check(
  "unrelated task success cannot satisfy an approval",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [fact({ taskId: "T9", wave: 2, status: "passed" })],
    wave: 2,
  }).errors[0]?.code === "missing_task_verification"
);
check(
  "unrelated action success cannot satisfy an approval",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: ["playwright.browser_take_screenshot"] }],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 2, status: "passed", action: "run" })],
    wave: 2,
  }).errors[0]?.code === "missing_task_verification"
);
check(
  "accepted project verifier failure blocks approval alongside declared browser evidence",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: ["playwright.browser_take_screenshot"] }],
    results: [approved],
    facts: [
      fact({
        taskId: "T1",
        wave: 2,
        status: "passed",
        action: "playwright.browser_take_screenshot",
      }),
      fact({
        taskId: "T1",
        wave: 2,
        status: "failed",
        action: "run",
        source: "project_verifier",
      }),
    ],
    wave: 2,
  }).errors.some((error) => error.code === "failed_task_verification")
);
check(
  "a later failure contradicts an earlier current-wave pass",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [
      fact({ taskId: "T1", wave: 2, status: "passed", at: "2026-07-10T10:00:00.000Z" }),
      fact({ taskId: "T1", wave: 2, status: "failed", at: "2026-07-10T10:01:00.000Z" }),
    ],
    wave: 2,
  }).errors[0]?.code === "failed_task_verification"
);
check(
  "a later skipped attempt does not erase a current-wave pass",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [
      fact({ taskId: "T1", wave: 2, status: "passed", at: "2026-07-10T10:00:00.000Z" }),
      fact({ taskId: "T1", wave: 2, status: "skipped", at: "2026-07-10T10:01:00.000Z" }),
    ],
    wave: 2,
  }).valid
);
check(
  "a skipped action alone is missing verification rather than a failed verifier",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 2, status: "skipped" })],
    wave: 2,
  }).errors[0]?.code === "missing_task_verification"
);
check(
  "non-approved results do not require evidence",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [{ ...approved, qualityVerdict: "fix" }],
    facts: [],
    wave: 2,
  }).valid
);
const mixed = validateBuildReviewApprovals({
  tasks: [toolTask, { ...toolTask, id: "T2", requiredToolActions: ["playwright.browser_navigate"] }],
  results: [approved, { ...approved, taskId: "T2" }],
  facts: [fact({ taskId: "T1", wave: 2, status: "passed" })],
  wave: 2,
});
check(
  "mixed task results report only the contradictory approval",
  !mixed.valid && mixed.errors.length === 1 && mixed.errors[0]?.taskId === "T2",
  mixed
);

let revisions = 0;
const blocked = await resolveBuildReviewContract({
  initialAction: { accepted: false },
  validate: (action) => ({
    valid: action.accepted,
    errors: action.accepted
      ? []
      : [{ code: "missing_task_verification" as const, taskId: "T1", message: "Missing run." }],
  }),
  revise: async () => {
    revisions += 1;
    return { accepted: false };
  },
  maxRevisions: 2,
});
check(
  "review revision exhaustion blocks after two attempts",
  blocked.status === "blocked" && blocked.revisions === 2 && revisions === 2,
  blocked
);

let cappedFacts: BuildTaskVerificationFact[] = [];
for (let wave = 1; wave <= 4; wave++) {
  cappedFacts = appendBuildTaskVerificationFact(
    cappedFacts,
    fact({ taskId: "T1", wave, status: "passed", at: `2026-07-10T10:0${wave}:00.000Z` }),
    3
  );
}
check(
  "verification fact ledger preserves wave while capping oldest facts",
  cappedFacts.length === 3 && cappedFacts[0]?.wave === 2 && cappedFacts.at(-1)?.wave === 4,
  cappedFacts
);
check(
  "later task writes discard only older facts for that task",
  discardSupersededTaskVerificationFacts(
    [
      fact({ taskId: "T1", wave: 1, status: "passed" }),
      fact({ taskId: "T1", wave: 3, status: "passed" }),
      fact({ taskId: "T2", wave: 1, status: "passed" }),
    ],
    "T1",
    3
  ).map((item) => `${item.taskId}:${item.wave}`).join(",") === "T1:3,T2:1"
);

const revisionPrompt = buildReviewContractRevisionPrompt({
  request: "Build the requested application.",
  action: { action: "review", results: [approved], done: true },
  facts: [fact({ taskId: "T1", wave: 2, status: "failed" })],
  errors: [{
    code: "failed_task_verification",
    taskId: "T1",
    message: "Task T1 run failed.",
  }],
});
check(
  "review revision prompt preserves action and exact objective facts and issue codes",
  revisionPrompt.includes("failed_task_verification") &&
    revisionPrompt.includes("Task T1 run failed.") &&
    revisionPrompt.includes('"status": "failed"') &&
    revisionPrompt.includes('"qualityVerdict": "approve"'),
  revisionPrompt
);
check(
  "live engine records only current task verification actions with wave provenance",
  /wave:\s*cycle/.test(buildEngineSource) &&
    /source:\s*"worker"/.test(buildEngineSource) &&
    /source:\s*"project_verifier"/.test(buildEngineSource) &&
    /requiredToolActions[^\n]*includes\(actionName\)/.test(buildEngineSource) &&
    /appendBuildTaskVerificationFact/.test(buildEngineSource) &&
    /discardSupersededTaskVerificationFacts/.test(buildEngineSource),
  "task-scoped fact production wiring is missing"
);
check(
  "live engine validates and revises review before applying results or scores",
  /resolveBuildReviewContract\(\{/.test(buildEngineSource) &&
    /buildReviewContractRevisionPrompt\(\{/.test(buildEngineSource) &&
    /stopForInvalidReviewContract/.test(buildEngineSource) &&
    /applicableCandidateResults/.test(buildEngineSource) &&
    buildEngineSource.indexOf("resolveBuildReviewContract({") <
      buildEngineSource.indexOf("extractReviewMemories({"),
  "review approval gate wiring is missing or ordered after review side effects"
);

process.exit(failed === 0 ? 0 : 1);

/** Build task retry policy checks (run: npx tsx scripts/test-build-task-retry-policy.mts) */
import {
  buildReviewFixProblem,
  buildReviewFixTaskUpdate,
  buildTaskFailureGuidanceUpdate,
  buildWorkerFinalResponseInstruction,
  decideBuildTaskFailure,
  hasWorkerFinalEvidenceResponse,
  renderBuildTaskInstructions,
  selectBalancedWorkerIndex,
  shouldRequestWorkerFinalOutput,
  type BuildTask,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const task = (failCount = 0): BuildTask => ({
  id: "T2",
  title: "Create audit JSON report",
  instructions: "Create docs/tool-call-audit-2.json",
  contextFiles: [],
  status: "planned",
  failCount,
});

const first = decideBuildTaskFailure(task(0), "bad", "returned no files");
check("first bad-output failure requeues", first.status === "fixing", first);
check("first failure count increments", first.failCount === 1, first);
check("bad-output note asks for file tool correction", /no usable output/i.test(first.instructionNote), first);

const second = decideBuildTaskFailure(task(1), "unavailable", "was unavailable (429 Rate limit exceeded)");
check("second transient failure still requeues", second.status === "fixing", second);
check("second failure count increments", second.failCount === 2, second);
check("transient note explains rate-limit retry", /transient provider failure/i.test(second.instructionNote), second);
check("transient retries include backoff", (second.retryDelayMs ?? 0) > 0, second);

const evidenceFailure = decideBuildTaskFailure(
  {
    ...task(0),
    kind: "verify",
    completionMode: "evidence",
    outputPaths: [],
  },
  "bad",
  "required evidence is missing"
);
check(
  "evidence-task retry asks for a bounded final report instead of file patching",
  /final evidence response/i.test(evidenceFailure.instructionNote) &&
    /Skill evidence:/i.test(evidenceFailure.instructionNote) &&
    !/append chunks|full-file block|patch for existing files/i.test(
      evidenceFailure.instructionNote
    ),
  evidenceFailure
);

const taskWithReview = buildReviewFixTaskUpdate(
  task(0),
  "Use the current acceptance criteria only.",
  [],
  8
);
const taskAfterFirstFailure = buildTaskFailureGuidanceUpdate(
  taskWithReview,
  first.instructionNote
);
const taskAfterSecondFailure = buildTaskFailureGuidanceUpdate(
  taskAfterFirstFailure,
  second.instructionNote
);
const renderedRetryInstructions = renderBuildTaskInstructions(taskAfterSecondFailure);
check(
  "retry notes replace stale failure guidance without discarding latest review feedback",
  taskAfterSecondFailure.instructions === "Create docs/tool-call-audit-2.json" &&
    taskAfterSecondFailure.reviewInstructions ===
      "Use the current acceptance criteria only." &&
    !taskAfterSecondFailure.retryInstructions?.includes("returned no files") &&
    taskAfterSecondFailure.retryInstructions?.includes("429 Rate limit exceeded") &&
    (renderedRetryInstructions.match(/NOTE: a previous attempt/g) ?? []).length === 1,
  taskAfterSecondFailure
);
const evidenceRetryTask = buildTaskFailureGuidanceUpdate(
  {
    ...task(0),
    kind: "verify",
    completionMode: "evidence",
  },
  evidenceFailure.instructionNote
);
check(
  "incomplete evidence response persists a finalization-only next attempt",
  evidenceRetryTask.nextAttemptPhase === "finalizing",
  evidenceRetryTask
);

const architectFixAfterEvidenceRetry = buildReviewFixTaskUpdate(
  evidenceRetryTask,
  "The Architect needs one missing browser interaction checked.",
  [],
  8
);
check(
  "Architect fix explicitly returns the task to scoped gathering",
  architectFixAfterEvidenceRetry.nextAttemptPhase === "gathering" &&
    architectFixAfterEvidenceRetry.retryInstructions === undefined,
  architectFixAfterEvidenceRetry
);

const third = decideBuildTaskFailure(task(2), "unavailable", "was unavailable (429 Rate limit exceeded)");
check("third failure gives up", third.status === "failed", third);
check("third failure count increments", third.failCount === 3, third);

const avoidedSelection = selectBalancedWorkerIndex({
  activeWorkerIndexes: [0, 1],
  assignmentCounts: new Map([
    [0, 0],
    [1, 0],
  ]),
  assignCursor: 0,
  avoidWorkerIndexes: [0],
});
check("retry assignment avoids the previous worker when alternatives exist", avoidedSelection.index === 1, avoidedSelection);

const reviewFixTask = buildReviewFixTaskUpdate(
  {
    ...task(1),
    workerIndex: 1,
    retryAfterMs: 12345,
    avoidWorkerIndexes: [0],
    outputPaths: ["src/main.js"],
  },
  "Browser acceptance evidence is incomplete.",
  ["src/main.js"],
  8,
  { avoidWorkerIndex: 1 }
);
check("review fix update clears stale worker pin", reviewFixTask.workerIndex === undefined, reviewFixTask);
check("review fix update clears stale retry delay", reviewFixTask.retryAfterMs === undefined, reviewFixTask);
check("review fix update records workers to avoid on retry", reviewFixTask.avoidWorkerIndexes?.join(",") === "0,1", reviewFixTask);

const reviewProblem = buildReviewFixProblem({
  taskId: "T3",
  taskTitle: "Integrate renderer lifecycle in main.js",
  reviewerName: "GPT-5.5",
  result: {
    taskId: "T3",
    specVerdict: "fix",
    qualityVerdict: "fix",
    specIssues: "Browser evidence did not cover the full workflow.",
    qualityIssues: "Console evidence after interactions is missing.",
    fixInstructions: "Run the structured browser acceptance checklist.",
  },
});
check("review fix problem has a durable problem code", reviewProblem.code === "review_fix_required", reviewProblem);
check("review fix problem preserves browser evidence details", /Browser evidence/i.test(reviewProblem.details), reviewProblem);

check(
  "worker with expected file output gets final-output prompt even after clean tool reads",
  shouldRequestWorkerFinalOutput({
    hasLandedFiles: false,
    hasPreviewArtifacts: false,
    hasScopedVerificationGapReport: false,
    expectsFileOutput: true,
    toolIssueCount: 0,
  }) === true
);
check(
  "worker with landed files does not need final-output prompt",
  shouldRequestWorkerFinalOutput({
    hasLandedFiles: true,
    hasPreviewArtifacts: false,
    hasScopedVerificationGapReport: false,
    expectsFileOutput: true,
    toolIssueCount: 0,
  }) === false
);
check(
  "evidence-only transitional prose is forced through the finalization phase",
  shouldRequestWorkerFinalOutput({
    hasLandedFiles: false,
    hasPreviewArtifacts: false,
    hasScopedVerificationGapReport: false,
    expectsFileOutput: false,
    toolIssueCount: 0,
    requiresFinalEvidenceResponse: true,
    hasFinalEvidenceResponse: false,
  }) === true
);
const completeEvidenceResponse = [
  "Task result: verification completed without file changes.",
  "Verification evidence: syntax and browser checks passed.",
  "Skill evidence:",
  "- aiboard:browser-acceptance: browser_navigate and console checks completed.",
].join("\n");
check(
  "structured evidence report is recognized as a real final response",
  hasWorkerFinalEvidenceResponse(completeEvidenceResponse) &&
    !shouldRequestWorkerFinalOutput({
      hasLandedFiles: false,
      hasPreviewArtifacts: false,
      hasScopedVerificationGapReport: false,
      expectsFileOutput: false,
      toolIssueCount: 0,
      requiresFinalEvidenceResponse: true,
      hasFinalEvidenceResponse: hasWorkerFinalEvidenceResponse(
        completeEvidenceResponse
      ),
    }),
  completeEvidenceResponse
);
check(
  "evidence-only worker ending on a tool action gets a final evidence turn",
  shouldRequestWorkerFinalOutput({
    hasLandedFiles: false,
    hasPreviewArtifacts: false,
    hasScopedVerificationGapReport: false,
    expectsFileOutput: false,
    toolIssueCount: 0,
    endedWithToolAction: true,
  }) === true
);
const evidenceFinalInstruction = buildWorkerFinalResponseInstruction({
  expectsFileOutput: false,
});
check(
  "evidence-only final turn asks for a Skill evidence report instead of files",
  /final evidence response/i.test(evidenceFinalInstruction) &&
    /Task result:/i.test(evidenceFinalInstruction) &&
    /Verification evidence:/i.test(evidenceFinalInstruction) &&
    /Skill evidence:/i.test(evidenceFinalInstruction) &&
    /Do not emit JSON tool actions/i.test(evidenceFinalInstruction) &&
    !/output the files\/patches/i.test(evidenceFinalInstruction),
  evidenceFinalInstruction
);
check(
  "tool issues still trigger final-output recovery",
  shouldRequestWorkerFinalOutput({
    hasLandedFiles: false,
    hasPreviewArtifacts: false,
    hasScopedVerificationGapReport: false,
    expectsFileOutput: false,
    toolIssueCount: 1,
  }) === true
);

process.exit(failed === 0 ? 0 : 1);

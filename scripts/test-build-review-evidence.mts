/** Build review evidence contract checks (run: npx tsx scripts/test-build-review-evidence.mts) */
import { readFileSync } from "node:fs";
import {
  appendBuildTaskVerificationFact,
  buildExpectedFailureEvidenceResponse,
  discardSupersededTaskVerificationFacts,
  pendingExpectedFailureVerifierCommands,
  resolveBuildReviewContract,
  validateBuildReviewApprovals,
  validateReadOnlyReviewFixes,
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
const readOnlyAudit: BuildTask = {
  id: "T-audit",
  title: "Audit public API",
  instructions: "Inspect and report the public API without editing files.",
  kind: "audit",
  completionMode: "evidence",
  verificationPolicy: "architect",
  contextFiles: ["src/game.js"],
  outputPaths: [],
  status: "review",
};
const incompatibleReadOnlyFix: ReviewResult = {
  taskId: "T-audit",
  specVerdict: "fix",
  qualityVerdict: "fix",
  fixInstructions:
    "Use typed file edits in src/game.js. Remove the duplicate export and run node --test tests/game.test.mjs.",
};
const evidenceOnlyFix: ReviewResult = {
  taskId: "T-audit",
  specVerdict: "fix",
  qualityVerdict: "approve",
  fixInstructions:
    "Enumerate the missing public API names and provide the required repo_status evidence.",
};
const commandEvidenceFix: ReviewResult = {
  taskId: "T-audit",
  specVerdict: "fix",
  qualityVerdict: "approve",
  fixInstructions:
    "Run node --check src/game.js and report the exact exit status as missing verification evidence. Do not modify files.",
};
check(
  "read-only review contract rejects implementation instructions on the audit task",
  validateReadOnlyReviewFixes({
    tasks: [readOnlyAudit],
    results: [incompatibleReadOnlyFix],
  }).errors.some(
    (issue) =>
      issue.code === "read_only_task_mutation" && issue.taskId === "T-audit"
  ),
  validateReadOnlyReviewFixes
);
check(
  "read-only review contract accepts a genuine missing-evidence correction",
  validateReadOnlyReviewFixes({
    tasks: [readOnlyAudit],
    results: [evidenceOnlyFix],
  }).valid,
  validateReadOnlyReviewFixes
);
check(
  "read-only evidence task may be returned for non-mutating command evidence",
  validateReadOnlyReviewFixes({
    tasks: [readOnlyAudit],
    results: [commandEvidenceFix],
  }).valid,
  validateReadOnlyReviewFixes({
    tasks: [readOnlyAudit],
    results: [commandEvidenceFix],
  })
);
const scopedModifyTask: BuildTask = {
  id: "T-red",
  title: "Add RED renderer regression tests",
  instructions: "Create the declared RED test only.",
  kind: "modify",
  completionMode: "files",
  verificationPolicy: "tool",
  contextFiles: ["src/renderer.js"],
  outputPaths: ["tests/renderer.test.mjs"],
  testOutputPaths: ["tests/renderer.test.mjs"],
  status: "review",
};
const scopeExpandingFix: ReviewResult = {
  taskId: "T-red",
  specVerdict: "fix",
  qualityVerdict: "fix",
  fixInstructions:
    "You may modify src/game.js and tests/game.test.mjs to repair an unrelated import blocker before finishing tests/renderer.test.mjs.",
};
check(
  "review fix cannot expand a modify task beyond its declared output paths",
  validateReadOnlyReviewFixes({
    tasks: [scopedModifyTask],
    results: [scopeExpandingFix],
  }).errors.some(
    (issue) =>
      issue.code === "out_of_scope_task_fix" && issue.taskId === "T-red"
  ),
  validateReadOnlyReviewFixes({
    tasks: [scopedModifyTask],
    results: [scopeExpandingFix],
  })
);
const toolTask: BuildTask = {
  id: "T1",
  title: "Verify the application",
  instructions: "Run the declared checks.",
  contextFiles: [],
  outputPaths: [],
  status: "review",
  verificationPolicy: "tool",
  requiredToolActions: ["run"],
  writeGeneration: 1,
  phaseSpec: {
    id: "P1",
    objective: "Verify the application",
    acceptanceCriteria: [],
    qualityCriteria: [],
    verification: ["npm test"],
    constraints: [],
  },
};
const redToolTask: BuildTask = {
  ...toolTask,
  id: "T-red",
  title: "Add RED deterministic tests",
  instructions:
    "This is the RED phase. The persisted test must fail for the expected missing behavior before implementation.",
  requiredEvidence: [
    "RED evidence from running `node tests/engagement.test.js` before implementation.",
  ],
  outputPaths: ["tests/engagement.test.js"],
  testOutputPaths: ["tests/engagement.test.js"],
  writeGeneration: 1,
};
const approvedRed: ReviewResult = {
  ...approved,
  taskId: "T-red",
};
const redFailureFact: BuildTaskVerificationFact = {
  taskId: "T-red",
  wave: 2,
  status: "failed",
  at: "2026-07-10T10:00:00.000Z",
  action: "run",
  verifierIdentity: "node tests/engagement.test.js",
  coveredPaths: [],
  source: "worker",
  summary: "Expected missing engagement helper failure.",
  writeGeneration: 1,
};
check(
  "RED task exposes its exact expected-failure command when current evidence is missing",
  pendingExpectedFailureVerifierCommands({
    task: redToolTask,
    facts: [],
    wave: 2,
    projectVerifier: "npm test",
  }).join(",") === "node tests/engagement.test.js",
  redToolTask
);
check(
  "current exact RED command fact suppresses redundant engine verification",
  pendingExpectedFailureVerifierCommands({
    task: redToolTask,
    facts: [redFailureFact],
    wave: 2,
    projectVerifier: "npm test",
  }).length === 0,
  redFailureFact
);
const engineRedEvidenceResponse = buildExpectedFailureEvidenceResponse({
  task: redToolTask,
  facts: [redFailureFact],
  wave: 2,
  durableFiles: ["tests/engagement.test.js"],
  projectVerifier: "npm test",
});
check(
  "engine RED evidence response is structured and grounded in the exact failed fact",
  /Task result:/i.test(engineRedEvidenceResponse) &&
    /Verification evidence:/i.test(engineRedEvidenceResponse) &&
    /Skill evidence:/i.test(engineRedEvidenceResponse) &&
    engineRedEvidenceResponse.includes("node tests/engagement.test.js") &&
    /failed/i.test(engineRedEvidenceResponse),
  engineRedEvidenceResponse
);
check(
  "expected failure of the exact RED command satisfies RED task verification",
  validateBuildReviewApprovals({
    tasks: [redToolTask],
    results: [approvedRed],
    facts: [redFailureFact],
    wave: 2,
    projectVerifier: "npm test",
  }).valid,
  redToolTask
);
check(
  "unexpectedly passing RED command does not satisfy RED evidence",
  !validateBuildReviewApprovals({
    tasks: [redToolTask],
    results: [approvedRed],
    facts: [{ ...redFailureFact, status: "passed" }],
    wave: 2,
    projectVerifier: "npm test",
  }).valid,
  redToolTask
);
const fact = (
  input: Partial<BuildTaskVerificationFact> & Pick<BuildTaskVerificationFact, "taskId" | "wave" | "status">
): BuildTaskVerificationFact => ({
  at: "2026-07-10T10:00:00.000Z",
  action: "run",
  summary: "npm test exited successfully.",
  coveredPaths: ["src/app.ts"],
  source: "worker",
  writeGeneration: 1,
  verifierIdentity:
    input.verifierIdentity ??
    (input.action && input.action !== "run" ? input.action : "npm test"),
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
  "phase-verification-covered tool task without facts is blocked",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: undefined }],
    results: [approved],
    facts: [],
    wave: 2,
  }).errors[0]?.code === "missing_task_verification"
);
check(
  "phase-only coverage ignores unrelated worker runs but remains missing",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: undefined }],
    results: [approved],
    facts: [
      fact({ taskId: "T1", wave: 2, status: "failed", source: "worker", verifierIdentity: "echo bad" }),
      fact({ taskId: "T1", wave: 2, status: "skipped", source: "worker", verifierIdentity: "echo skip" }),
    ],
    wave: 2,
  }).errors[0]?.code === "missing_task_verification"
);
const taskScopedVerifierTask: BuildTask = {
  ...toolTask,
  id: "T-scoped",
  title: "Repair game import",
  outputPaths: ["src/game.js"],
  requiredEvidence: [
    "GREEN: `node --check src/game.js` passes after the fix.",
    "GREEN: `node --test tests/game.test.mjs` passes after the fix.",
    "Confirm `ENGAGEMENT_DEFAULTS` is initialized after its dependencies.",
  ],
  phaseSpec: {
    ...toolTask.phaseSpec!,
    verification: [
      "node --check src/game.js",
      "node --test tests/game.test.mjs",
      "node --test tests/future-renderer.test.mjs",
      "Playwright browser acceptance assigned to a future task",
    ],
  },
};
check(
  "task-specific verifier evidence does not inherit unrelated whole-phase checks",
  validateBuildReviewApprovals({
    tasks: [taskScopedVerifierTask],
    results: [{ ...approved, taskId: "T-scoped" }],
    facts: [
      fact({
        taskId: "T-scoped",
        wave: 2,
        status: "passed",
        verifierIdentity: "node --check src/game.js",
        coveredPaths: ["src/game.js"],
      }),
      fact({
        taskId: "T-scoped",
        wave: 2,
        status: "passed",
        verifierIdentity: "node --test tests/game.test.mjs",
        coveredPaths: ["src/game.js"],
      }),
    ],
    wave: 2,
  }).valid,
  taskScopedVerifierTask
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
    projectVerifier: "npm test",
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
    projectVerifier: "npm test",
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
  "same-generation worker verification survives a no-write recovery wave",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 1, status: "passed" })],
    wave: 2,
  }).valid
);
check(
  "project verifier evidence remains current-wave scoped",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: undefined }],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 1,
      status: "passed",
      source: "project_verifier",
    })],
    wave: 2,
    projectVerifier: "npm test",
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
  "run before a landed patch cannot approve the newer task generation",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, outputPaths: ["src/app.ts"] }],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 2, status: "passed", writeGeneration: 0 })],
    wave: 2,
  }).errors[0]?.code === "stale_task_verification"
);
check(
  "run before final file output cannot approve the newer task generation",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, outputPaths: ["src/app.ts"], writeGeneration: 2 }],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 2, status: "passed", writeGeneration: 1 })],
    wave: 2,
  }).errors[0]?.code === "stale_task_verification"
);
check(
  "unrelated successful command cannot satisfy the declared verifier",
  validateBuildReviewApprovals({
    tasks: [{
      ...toolTask,
      phaseSpec: {
        id: "P1",
        objective: "Ship the app",
        acceptanceCriteria: [],
        qualityCriteria: [],
        verification: ["npm test"],
        constraints: [],
      },
    }],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      verifierIdentity: "echo ok",
    })],
    wave: 2,
  }).errors.some((error) => error.code === "missing_task_verification")
);
check(
  "successful verifier without full declared path coverage cannot approve",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, outputPaths: ["src/app.ts", "src/config.ts"] }],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      source: "project_verifier",
      verifierIdentity: "npm test",
      coveredPaths: ["src/app.ts"],
    })],
    wave: 2,
    projectVerifier: "npm test",
  }).errors.some((error) => error.code === "missing_task_verification")
);
const phaseScopedPathTask: BuildTask = {
  ...toolTask,
  outputPaths: ["src/app.ts"],
};
check(
  "phase command does not approve a path owner without compiler-declared coverage",
  !validateBuildReviewApprovals({
    tasks: [phaseScopedPathTask],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      coveredPaths: [],
    })],
    wave: 2,
  }).valid
);
check(
  "phase command approves current landed generation with full compiled path coverage",
  validateBuildReviewApprovals({
    tasks: [phaseScopedPathTask],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      coveredPaths: ["src/app.ts"],
    })],
    wave: 2,
  }).valid
);
const phaseOnlyTask: BuildTask = {
  ...toolTask,
  requiredToolActions: undefined,
  phaseSpec: {
    id: "P1",
    objective: "Ship the app",
    acceptanceCriteria: [],
    qualityCriteria: [],
    verification: ["npm test"],
    constraints: [],
  },
};
check(
  "phase verification compiles to an objective approval requirement",
  validateBuildReviewApprovals({
    tasks: [phaseOnlyTask],
    results: [approved],
    facts: [],
    wave: 2,
  }).errors[0]?.code === "missing_task_verification"
);
check(
  "phase verification is satisfied only by the exact executed check",
  validateBuildReviewApprovals({
    tasks: [phaseOnlyTask],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      source: "project_verifier",
      verifierIdentity: "npm test",
    })],
    wave: 2,
  }).valid
);
check(
  "verifier identity comparison preserves exact command arguments and casing",
  !validateBuildReviewApprovals({
    tasks: [phaseOnlyTask],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      source: "project_verifier",
      verifierIdentity: "NPM TEST",
    })],
    wave: 2,
  }).valid
);
const requiredEvidenceTask: BuildTask = {
  ...toolTask,
  requiredToolActions: undefined,
  requiredEvidence: ["Run `npm test` and record its successful exit."],
};
check(
  "required evidence compiles to an objective approval requirement",
  validateBuildReviewApprovals({
    tasks: [requiredEvidenceTask],
    results: [approved],
    facts: [],
    wave: 2,
  }).errors[0]?.code === "missing_task_verification"
);
check(
  "required evidence is satisfied only by its exact executed check",
  validateBuildReviewApprovals({
    tasks: [requiredEvidenceTask],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      verifierIdentity: "npm test",
    })],
    wave: 2,
  }).valid
);
check(
  "accepted project verifier remains required when no fact was produced",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, requiredToolActions: undefined }],
    results: [approved],
    facts: [],
    wave: 2,
    projectVerifier: "npm test",
  }).errors[0]?.code === "missing_task_verification"
);
check(
  "bare run action is satisfied by the accepted concrete project verifier",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, phaseSpec: undefined }],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      source: "project_verifier",
      verifierIdentity: "npm test",
    })],
    wave: 2,
    projectVerifier: "npm test",
  }).valid
);
check(
  "semantic RED GREEN prose remains Architect context rather than command identity",
  validateBuildReviewApprovals({
    tasks: [{
      ...toolTask,
      requiredEvidence: ["Observe the RED failure.", "Record the GREEN passing run."],
    }],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 2, status: "passed" })],
    wave: 2,
  }).valid
);
check(
  "legacy fact without landed generation fails closed for approval",
  !validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      writeGeneration: undefined,
    })],
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
    projectVerifier: "npm test",
  }).errors.some((error) => error.code === "failed_task_verification")
);
const overlappingRunObligations = validateBuildReviewApprovals({
  tasks: [toolTask],
  results: [approved],
  facts: [
    fact({
      taskId: "T1",
      wave: 2,
      status: "failed",
      action: "run",
      source: "project_verifier",
    }),
  ],
  wave: 2,
  projectVerifier: "npm test",
});
check(
  "explicit run plus project verifier emits one actionable failure issue",
  overlappingRunObligations.errors.length === 1 &&
    overlappingRunObligations.errors[0]?.code === "failed_task_verification",
  overlappingRunObligations
);
const twoCommandTask: BuildTask = {
  ...toolTask,
  requiredToolActions: undefined,
  phaseSpec: {
    ...toolTask.phaseSpec!,
    verification: ["npm test", "npm run lint"],
  },
};
const twoMissingCommands = validateBuildReviewApprovals({
  tasks: [twoCommandTask],
  results: [approved],
  facts: [],
  wave: 2,
});
check(
  "two missing exact run requirements retain distinct actionable verifier issues",
  twoMissingCommands.errors.length === 2 &&
    twoMissingCommands.errors.some((error) => error.message.includes('"npm test"')) &&
    twoMissingCommands.errors.some((error) => error.message.includes('"npm run lint"')),
  twoMissingCommands
);
check(
  "successful AND-chained command satisfies each exact component verifier",
  validateBuildReviewApprovals({
    tasks: [twoCommandTask],
    results: [approved],
    facts: [fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      verifierIdentity: "node -e \"console.log('preflight')\" && npm test && npm run lint",
      summary: "all chained checks passed",
    })],
    wave: 2,
  }).valid
);
const twoCommandMismatches = validateBuildReviewApprovals({
  tasks: [twoCommandTask],
  results: [approved],
  facts: [
    fact({
      taskId: "T1",
      wave: 2,
      status: "failed",
      verifierIdentity: "npm test",
      summary: "tests failed",
    }),
    fact({
      taskId: "T1",
      wave: 2,
      status: "passed",
      verifierIdentity: "npm run lint",
      writeGeneration: 0,
      summary: "lint passed before the latest write",
    }),
  ],
  wave: 2,
});
check(
  "two exact run requirements report verifier-specific failure and stale-generation mismatches",
  twoCommandMismatches.errors.length === 2 &&
    twoCommandMismatches.errors.some(
      (error) =>
        error.code === "failed_task_verification" &&
        error.message.includes('"npm test"') &&
        error.message.includes("failed")
    ) &&
    twoCommandMismatches.errors.some(
      (error) =>
        error.code === "stale_task_verification" &&
        error.message.includes('"npm run lint"') &&
        error.message.includes("generation")
    ),
  twoCommandMismatches
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
  tasks: [toolTask, { ...toolTask, id: "T2", phaseSpec: undefined, requiredToolActions: ["playwright.browser_navigate"] }],
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
    /isCompiledVerificationAction/.test(buildEngineSource) &&
    /appendBuildTaskVerificationFact/.test(buildEngineSource) &&
    /discardSupersededTaskVerificationFacts/.test(buildEngineSource) &&
    /writeGeneration/.test(buildEngineSource) &&
    /verifierIdentity/.test(buildEngineSource),
  "task-scoped fact production wiring is missing"
);
check(
  "live engine uses compiled requirements for worker fact production without invented path coverage",
  /compileBuildTaskVerificationRequirements/.test(buildEngineSource) &&
    /successfulRunIdentityIncludes/.test(buildEngineSource) &&
    /compiledCoverage/.test(buildEngineSource) &&
    /flatMap\(\(requirement\)\s*=>\s*requirement\.coveredPaths\)/.test(buildEngineSource),
  "worker facts are not driven by the shared requirement compiler"
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
check(
  "file-producing workers reserve finalization when active skills require evidence",
  /requiresFinalEvidenceResponse:\s*taskContract\.completionMode\s*!==\s*"files"\s*\|\|\s*workerSkills\.evidenceRequired\.length\s*>\s*0/.test(
    buildEngineSource
  ),
  "file tasks can finish without the structured evidence required by their active skills"
);
check(
  "landed worker writes invalidate same-attempt tool dedup state",
  /recordTaskLandedWrite[\s\S]{0,500}tracker\.exact\.clear\(\)[\s\S]{0,120}tracker\.ranges\.clear\(\)[\s\S]{0,120}replayCache\.clear\(\)/.test(
    buildEngineSource
  ),
  "post-patch verification can replay stale pre-patch tool results"
);
check(
  "no-change recovery with current passing checks records deterministic refactor evidence",
  /files\.length\s*===\s*0[\s\S]{0,260}currentTaskHasPassingVerification[\s\S]{0,300}Refactor was not needed/.test(
    buildEngineSource
  ),
  "evidence-only recovery waves can loop solely because the model omitted refactor wording"
);
check(
  "deferred future-owned project checks do not block the current task review",
  /validateBuildReviewApprovals\(\{[\s\S]{0,300}projectVerifier:\s*verifyResult\.deferred\s*\?\s*""\s*:\s*verifyCommand/.test(
    buildEngineSource
  ),
  "review requires a project verifier that the scheduler deliberately deferred to future owners"
);
check(
  "Architect review commands are disabled when the reviewed wave has no tool-policy tasks",
  /allowRun:\s*reviewRequiresToolVerification/.test(buildEngineSource) &&
    /runsLeft:\s*reviewRequiresToolVerification\s*\?\s*runsLeftThisPhase\(\)\s*:\s*0/.test(
      buildEngineSource
    ) &&
    /!allowRun\s*&&\s*item\.action\.action\s*===\s*"run"/.test(buildEngineSource),
  "review command budget is not scoped to task verification policy"
);

process.exit(failed === 0 ? 0 : 1);

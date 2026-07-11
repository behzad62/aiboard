/** Bounded Build plan contract revision checks (run: npx tsx scripts/test-build-plan-revision.mts) */
import { readFileSync } from "node:fs";
import {
  hasBuildPlanVerificationStateChanged,
  resolveBuildPlanContract,
  preserveBuildTaskRuntimeState,
  resolveBuildPlanReviewVerificationState,
  resolveBuildPlanVerifyCommand,
  validateBuildPlanContract,
} from "../lib/orchestrator/build-plan-contract";
import {
  buildPlanContractRevisionPrompt,
  type BuildTask,
} from "../lib/orchestrator/build";
import {
  adoptBuildReviewVerificationState,
  materializeBuildEnginePlanTasks,
} from "../lib/client/build-engine";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const task = (id: string, outputPaths: string[], dependsOn: string[] = []): BuildTask => ({
  id,
  title: id,
  instructions: `Implement ${id}`,
  contextFiles: [],
  outputPaths,
  status: "planned",
  dependsOn,
});

const invalidPlan = {
  action: "build_plan" as const,
  tasks: [task("T1", ["src/shared.ts"]), task("T2", ["src/shared.ts"])],
  notes: "Keep the public API stable.",
};
const validPlan = {
  ...invalidPlan,
  tasks: [task("T1", ["src/shared.ts"]), task("T2", ["src/shared.ts"], ["T1"])],
};

const toolPolicyPlan = {
  action: "build_plan" as const,
  tasks: [
    {
      ...task("T-tool", ["src/tool.ts"]),
      verificationPolicy: "tool" as const,
      requiredToolActions: [],
    },
  ],
};
const verifierBeforeReview = resolveBuildPlanVerifyCommand({
  current: "npm test",
});
const reviewVerificationAfterDisable = resolveBuildPlanReviewVerificationState({
  currentVerifyCommand: verifierBeforeReview,
  requestedVerifyCommand: "",
  phaseVerification: [verifierBeforeReview],
});
const verifierAfterDisable = reviewVerificationAfterDisable.verifyCommand;
let disableRevisionAttempts = 0;
const dispatchAfterDisable = await resolveBuildPlanContract({
  initialPlan: toolPolicyPlan,
  validate: (plan) =>
    validateBuildPlanContract(plan.tasks, {
      verifyCommand: verifierAfterDisable,
      phaseVerification: reviewVerificationAfterDisable.phaseVerification,
    }),
  revise: async () => {
    disableRevisionAttempts += 1;
    return toolPolicyPlan;
  },
  maxRevisions: 2,
});
const dispatchReadyTasks =
  dispatchAfterDisable.status === "valid" ? dispatchAfterDisable.plan.tasks : [];
const blockedCheckpointVerifyCommand = resolveBuildPlanVerifyCommand({
  current: verifierAfterDisable,
  requested: dispatchAfterDisable.plan.verifyCommand,
});
check(
  "explicit review verifier disable blocks tool task dispatch",
  validateBuildPlanContract(toolPolicyPlan.tasks, {
    verifyCommand: verifierBeforeReview,
  }).valid &&
    verifierAfterDisable === "" &&
    reviewVerificationAfterDisable.phaseVerification.length === 0 &&
    dispatchAfterDisable.status === "blocked" &&
    disableRevisionAttempts === 2 &&
    dispatchReadyTasks.length === 0 &&
    blockedCheckpointVerifyCommand === "" &&
    dispatchAfterDisable.validation.errors.some(
      (issue) => issue.code === "missing_tool_verification_contract"
    ),
  {
    verifierBeforeReview,
    reviewVerificationAfterDisable,
    disableRevisionAttempts,
    dispatchReadyTasks,
    blockedCheckpointVerifyCommand,
    dispatchAfterDisable,
  }
);

const phaseOnlyBefore = {
  verifyCommand: "",
  phaseVerification: ["npm test"],
};
const phaseOnlyAfter = resolveBuildPlanReviewVerificationState({
  currentVerifyCommand: phaseOnlyBefore.verifyCommand,
  phaseVerification: [],
});
let phaseOnlyRevisionAttempts = 0;
const phaseOnlyBlocked = await resolveBuildPlanContract({
  initialPlan: toolPolicyPlan,
  validate: (plan) =>
    validateBuildPlanContract(plan.tasks, {
      verifyCommand: phaseOnlyAfter.verifyCommand,
      phaseVerification: phaseOnlyAfter.phaseVerification,
    }),
  revise: async () => {
    phaseOnlyRevisionAttempts += 1;
    return toolPolicyPlan;
  },
  maxRevisions: 2,
});
check(
  "phase-only verifier removal revalidates and blocks dispatch",
  hasBuildPlanVerificationStateChanged(phaseOnlyBefore, phaseOnlyAfter) &&
    phaseOnlyBlocked.status === "blocked" &&
    phaseOnlyRevisionAttempts === 2 &&
    (phaseOnlyBlocked.status === "valid" ? phaseOnlyBlocked.plan.tasks : []).length === 0,
  { phaseOnlyBefore, phaseOnlyAfter, phaseOnlyBlocked, phaseOnlyRevisionAttempts }
);

const fixingRuntimeTask: BuildTask = {
  ...toolPolicyPlan.tasks[0],
  status: "fixing",
  reviewInstructions: "Preserve this exact review correction.",
  retryInstructions: "Retry only after refreshing context.",
  nextAttemptPhase: "finalizing",
  splitDepth: 1,
  workerIndex: 2,
  failCount: 1,
  writeGeneration: 7,
  retryAfterMs: 1234,
  avoidWorkerIndexes: [0, 2],
  unavailableWorkerIndexes: [1],
  guidance: [
    {
      id: "G-T-tool-1",
      taskId: "T-tool",
      mode: "async",
      question: "Keep the API?",
      status: "answered",
      answer: "Yes.",
      requestedAtWave: 1,
    },
  ],
};
const revisedRuntimeTask: BuildTask = {
  ...fixingRuntimeTask,
  id: "t-tool",
  title: "Architect-revised title",
  instructions: "Architect-revised contract.",
  status: "planned",
  reviewInstructions: undefined,
  retryInstructions: undefined,
  nextAttemptPhase: undefined,
  splitDepth: undefined,
  writeGeneration: 0,
};
const preservedRuntimeTask = preserveBuildTaskRuntimeState(
  [revisedRuntimeTask],
  [fixingRuntimeTask]
)[0];
check(
  "review contract revision preserves fixing and split runtime state",
  preservedRuntimeTask.id === "t-tool" &&
    preservedRuntimeTask.title === "Architect-revised title" &&
    preservedRuntimeTask.instructions === "Architect-revised contract." &&
    preservedRuntimeTask.status === "fixing" &&
    preservedRuntimeTask.reviewInstructions === fixingRuntimeTask.reviewInstructions &&
    preservedRuntimeTask.retryInstructions === fixingRuntimeTask.retryInstructions &&
    preservedRuntimeTask.nextAttemptPhase === "finalizing" &&
    preservedRuntimeTask.splitDepth === 1 &&
    preservedRuntimeTask.workerIndex === 2 &&
    preservedRuntimeTask.failCount === 1 &&
    preservedRuntimeTask.writeGeneration === 7 &&
    preservedRuntimeTask.retryAfterMs === 1234 &&
    preservedRuntimeTask.avoidWorkerIndexes?.join(",") === "0,2" &&
    preservedRuntimeTask.unavailableWorkerIndexes?.join(",") === "1" &&
    preservedRuntimeTask.guidance?.[0]?.answer === "Yes.",
  preservedRuntimeTask
);

const adoptedEngineReviewState = adoptBuildReviewVerificationState({
  verifyCommand: "",
  phaseSpec: {
    id: "P-review",
    objective: "Adopt the Architect's phase verifier.",
    acceptanceCriteria: ["The task contract remains dispatch-valid."],
    qualityCriteria: ["Do not rewrite adopted verification state."],
    verification: ["npm test"],
  },
});
check(
  "engine adopts the exact validated review verification state",
  adoptedEngineReviewState.verifyCommand === "" &&
    adoptedEngineReviewState.phaseSpec?.verification?.join(",") ===
      "npm test" &&
    validateBuildPlanContract(toolPolicyPlan.tasks, {
      verifyCommand: adoptedEngineReviewState.verifyCommand,
      phaseVerification: adoptedEngineReviewState.phaseSpec?.verification,
    }).valid,
  adoptedEngineReviewState
);

const engineResumeTask = materializeBuildEnginePlanTasks(
  [revisedRuntimeTask],
  [fixingRuntimeTask]
)[0];
const engineBlockedTask = materializeBuildEnginePlanTasks(
  [{ ...revisedRuntimeTask, title: "Blocked revised title" }],
  [fixingRuntimeTask]
)[0];
check(
  "engine resume and blocked materialization preserve runtime metadata",
  engineResumeTask.status === "fixing" &&
    engineResumeTask.reviewInstructions === fixingRuntimeTask.reviewInstructions &&
    engineResumeTask.retryInstructions === fixingRuntimeTask.retryInstructions &&
    engineResumeTask.nextAttemptPhase === "finalizing" &&
    engineResumeTask.splitDepth === 1 &&
    engineResumeTask.writeGeneration === 7 &&
    engineBlockedTask.title === "Blocked revised title" &&
    engineBlockedTask.status === "fixing" &&
    engineBlockedTask.guidance?.[0]?.answer === "Yes.",
  { engineResumeTask, engineBlockedTask }
);

const corrected = await resolveBuildPlanContract({
  initialPlan: invalidPlan,
  validate: (plan) => validateBuildPlanContract(plan.tasks),
  revise: async () => validPlan,
  maxRevisions: 2,
});
check(
  "one corrected revision proceeds",
  corrected.status === "valid" && corrected.revisions === 1 && corrected.plan === validPlan,
  corrected
);

let revisions = 0;
const blocked = await resolveBuildPlanContract({
  initialPlan: invalidPlan,
  validate: (plan) => validateBuildPlanContract(plan.tasks),
  revise: async () => {
    revisions += 1;
    return invalidPlan;
  },
  maxRevisions: 2,
});
check(
  "persistent invalidity blocks after two revisions",
  blocked.status === "blocked" && blocked.revisions === 2 && revisions === 2,
  blocked
);

let nullRevisions = 0;
const nullBlocked = await resolveBuildPlanContract({
  initialPlan: invalidPlan,
  validate: (plan) => validateBuildPlanContract(plan.tasks),
  revise: async () => {
    nullRevisions += 1;
    return null;
  },
  maxRevisions: 2,
});
check(
  "unparseable revisions consume the bounded attempts",
  nullBlocked.status === "blocked" && nullBlocked.revisions === 2 && nullRevisions === 2,
  nullBlocked
);

const initialValidation = validateBuildPlanContract(invalidPlan.tasks);
const prompt = buildPlanContractRevisionPrompt({
  request: "Build the shared module without unsafe parallel writes.",
  spec: { objective: "Preserve the public API." },
  currentPlan: invalidPlan,
  validation: initialValidation,
  revision: 1,
  maxRevisions: 2,
});
check(
  "revision prompt includes request, spec, full plan, and exact issues",
  prompt.includes("Build the shared module without unsafe parallel writes.") &&
    prompt.includes('"objective": "Preserve the public API."') &&
    prompt.includes('"notes": "Keep the public API stable."') &&
    initialValidation.errors.every(
      (issue) => prompt.includes(issue.code) && prompt.includes(issue.message)
    ),
  prompt
);

const buildEngineSource = readFileSync(
  new URL("../lib/client/build-engine.ts", import.meta.url),
  "utf8"
);
check(
  "plan contract resolver validates only safety-accepted verifier commands",
  buildEngineSource.includes("acceptPlanVerifierForContract") &&
    /initialPlan:\s*acceptPlanVerifierForContract\(/.test(buildEngineSource) &&
    /\?\s*acceptPlanVerifierForContract\(\s*revised/.test(buildEngineSource),
  "initial or revised plans can still be validated with raw verifier text"
);
const reviewValidationIndex = buildEngineSource.indexOf(
  "const reviewPlanResolution = await resolveArchitectPlanContract"
);
const effectiveReviewVerifierIndex = buildEngineSource.indexOf(
  "const effectiveReviewVerifyCommand"
);
check(
  "review-created tasks validate against the review's effective verifier",
  effectiveReviewVerifierIndex >= 0 &&
    effectiveReviewVerifierIndex < reviewValidationIndex &&
    /const reviewPlan:[\s\S]{0,500}verifyCommand:\s*effectiveReviewVerifyCommand/.test(
      buildEngineSource
    ),
  "review task validation still uses stale verifier state"
);
check(
  "spec verifier is safety-accepted before the initial plan gate",
  /const acceptedSpecVerifyCommand = acceptVerifyCommandForRunner\(/.test(
    buildEngineSource
  ) &&
    /initialPlan: planAction,[\s\S]{0,300}fallbackVerifyCommand:\s*acceptedSpecVerifyCommand/.test(
      buildEngineSource
    ),
  "initial plan contract ignores the accepted spec verifier"
);
check(
  "critic revisions inherit the accepted spec verifier",
  /label:\s*"Architect correcting structurally invalid critique revision",[\s\S]{0,250}fallbackVerifyCommand:\s*acceptedSpecVerifyCommand/.test(
    buildEngineSource
  ),
  "critic plan contract validation loses the accepted spec verifier"
);
check(
  "resumed checkpoint revisions validate immutable task identities",
  /label:\s*"Architect revising resumed checkpoint plan",[\s\S]{0,300}immutableTasks:\s*tasks/.test(
    buildEngineSource
  ),
  "resume revision can silently repurpose an existing task id"
);
check(
  "validated review graphs are not semantically auto-repaired",
  !buildEngineSource.includes("filterNovelReviewTasks("),
  "engine still removes Architect tasks after contract validation"
);
check(
  "revision prompt requires one complete build_plan without semantic repair coaching",
  /one complete build_plan/i.test(prompt) &&
    !/add (?:a )?dependency|rename task|remove task|change verification/i.test(prompt),
  prompt
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Build plan revision checks passed.");

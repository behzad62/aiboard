/** Build plan contract compiler checks (run: npx tsx scripts/test-build-plan-contract.mts) */
import {
  hasRunnablePendingBuildTask,
  isBuildTaskRunnable,
  renderBuildPlanContractErrors,
  validateBuildPlanContract,
} from "../lib/orchestrator/build-plan-contract";
import type { BuildTask } from "../lib/orchestrator/build";
import {
  buildArchitectActionResponseFormat,
  normalizeBuildTaskContract,
  parseArchitectAction,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const task = (input: Partial<BuildTask> & Pick<BuildTask, "id">): BuildTask => ({
  id: input.id,
  title: input.title ?? input.id,
  instructions: input.instructions ?? "Complete the declared contract.",
  contextFiles: input.contextFiles ?? [],
  status: input.status ?? "planned",
  ...input,
});

const normalizedActions = normalizeBuildTaskContract(
  task({ id: "T0", requiredToolActions: [" run ", "playwright.browser_navigate"] })
);
check(
  "task normalization preserves typed required tool actions",
  normalizedActions.requiredToolActions?.join(",") ===
    "run,playwright.browser_navigate",
  normalizedActions
);
const architectTaskSchema = (
  buildArchitectActionResponseFormat().schema.properties?.tasks as {
    items?: { properties?: Record<string, unknown> };
  }
)?.items;
check(
  "Architect task JSON exposes required tool actions",
  Boolean(architectTaskSchema?.properties?.requiredToolActions),
  architectTaskSchema
);
const parsedPlan = parseArchitectAction(
  JSON.stringify({
    action: "plan",
    tasks: [
      {
        title: "Verify browser",
        instructions: "Verify the browser surface.",
        requiredToolActions: [" playwright.browser_navigate "],
      },
    ],
  })
);
check(
  "Architect plan parsing preserves normalized required tool actions",
  parsedPlan?.action === "plan" &&
    parsedPlan.tasks[0]?.requiredToolActions?.[0] ===
      "playwright.browser_navigate",
  parsedPlan
);

const duplicate = validateBuildPlanContract([task({ id: "T1" }), task({ id: "t1" })]);
check(
  "duplicate task ids are rejected case-insensitively",
  duplicate.errors.some((issue) => issue.code === "duplicate_task_id"),
  duplicate
);

const duplicateUnfinishedImplementation = validateBuildPlanContract([
  task({
    id: "T15",
    title: "Implement voxel renderer and engagement-envelope behavior with strict RED/GREEN evidence",
    kind: "modify",
    outputPaths: ["src/game.js", "src/renderer.js", "tests/renderer.test.mjs"],
  }),
  task({
    id: "T21",
    title: "Implement voxel renderer and engagement-envelope gameplay behavior",
    kind: "modify",
    outputPaths: ["src/game.js", "src/renderer.js", "tests/renderer.test.mjs"],
    dependsOn: ["T15"],
  }),
]);
check(
  "semantically duplicate unfinished tasks are rejected even when dependency-ordered",
  duplicateUnfinishedImplementation.errors.some(
    (issue) => issue.code === "duplicate_unfinished_task"
  ),
  duplicateUnfinishedImplementation
);

const duplicateTerminalGates = validateBuildPlanContract([
  task({ id: "T5", title: "Run final browser acceptance verification", kind: "verify", completionMode: "evidence" }),
  task({ id: "T11", title: "Run full automated and browser acceptance verification", kind: "verify", completionMode: "evidence", dependsOn: ["T5"] }),
]);
check(
  "multiple unfinished terminal verification tasks are rejected",
  duplicateTerminalGates.errors.some(
    (issue) => issue.code === "duplicate_unfinished_task"
  ),
  duplicateTerminalGates
);

const distinctVerificationPhases = validateBuildPlanContract([
  task({ id: "T5", title: "Run unit tests", kind: "verify", completionMode: "evidence" }),
  task({ id: "T11", title: "Run browser acceptance", kind: "verify", completionMode: "evidence", dependsOn: ["T5"] }),
]);
check(
  "distinct terminal verification phases remain valid",
  !distinctVerificationPhases.errors.some(
    (issue) => issue.code === "duplicate_unfinished_task"
  ),
  distinctVerificationPhases
);

const distinctSameFilePhases = validateBuildPlanContract([
  task({
    id: "T2",
    title: "Add RED renderer regression tests",
    kind: "modify",
    outputPaths: ["tests/renderer.test.mjs"],
  }),
  task({
    id: "T8",
    title: "Add accessibility keyboard regression tests",
    kind: "modify",
    outputPaths: ["tests/renderer.test.mjs"],
    dependsOn: ["T2"],
  }),
]);
check(
  "distinct dependency-ordered work in one shared file remains valid",
  !distinctSameFilePhases.errors.some(
    (issue) => issue.code === "duplicate_unfinished_task"
  ),
  distinctSameFilePhases
);

const immutableTask: BuildTask = task({
  id: "T2",
  title: "Add RED renderer regression tests",
  instructions: "Create only tests/renderer.test.mjs and capture expected RED evidence.",
  kind: "modify",
  completionMode: "files",
  verificationPolicy: "tool",
  outputPaths: ["tests/renderer.test.mjs"],
  requiredEvidence: ["Expected failure from `node --test tests/renderer.test.mjs`."],
});
const repurposedTaskIdentity = validateBuildPlanContract(
  [
    task({
      ...immutableTask,
      title: "Repair game import TDZ blocker",
      instructions: "Modify src/game.js and make game tests pass.",
      outputPaths: ["src/game.js", "tests/game.test.mjs"],
    }),
  ],
  { immutableTasks: [immutableTask] }
);
check(
  "resumed plans cannot repurpose an existing task id for a new contract",
  repurposedTaskIdentity.errors.some(
    (issue) => issue.code === "existing_task_contract_changed"
  ),
  repurposedTaskIdentity
);

const reroutedImmutableTask = validateBuildPlanContract(
  [task({ ...immutableTask, dependsOn: ["T1"] }), task({ id: "T1", status: "done" })],
  { immutableTasks: [immutableTask] }
);
check(
  "resumed plans may update dependencies without changing task identity",
  !reroutedImmutableTask.errors.some(
    (issue) => issue.code === "existing_task_contract_changed"
  ),
  reroutedImmutableTask
);

const badDependencies = validateBuildPlanContract([
  task({ id: "T1", dependsOn: ["missing", "T1"] }),
]);
check(
  "unknown dependencies are rejected",
  badDependencies.errors.some((issue) => issue.code === "unknown_dependency"),
  badDependencies
);
check(
  "self dependencies are rejected",
  badDependencies.errors.some((issue) => issue.code === "self_dependency"),
  badDependencies
);

const cyclic = validateBuildPlanContract([
  task({ id: "T1", dependsOn: ["T3"] }),
  task({ id: "T2", dependsOn: ["T1"] }),
  task({ id: "T3", dependsOn: ["T2"] }),
]);
check(
  "dependency cycles are rejected",
  cyclic.errors.some((issue) => issue.code === "dependency_cycle"),
  cyclic
);

const overlap = validateBuildPlanContract([
  task({ id: "T1", kind: "modify", outputPaths: ["src\\game.ts"] }),
  task({ id: "T2", kind: "modify", testOutputPaths: ["SRC/game.ts"] }),
]);
check(
  "unordered output owners are rejected with normalized paths",
  overlap.errors.some((issue) => issue.code === "unordered_output_overlap"),
  overlap
);

const immutableInput = [
  task({
    id: "T1",
    kind: "modify",
    outputPaths: ["src/game.ts"],
    dependsOn: [],
  }),
];
const immutableSnapshot = JSON.stringify(immutableInput);
validateBuildPlanContract(immutableInput, { strictTdd: true });
check(
  "contract validation never mutates Architect tasks",
  JSON.stringify(immutableInput) === immutableSnapshot,
  immutableInput
);

const ordered = validateBuildPlanContract([
  task({ id: "T1", kind: "modify", outputPaths: ["src/game.ts"] }),
  task({ id: "T2", kind: "modify", dependsOn: ["T1"] }),
  task({
    id: "T3",
    kind: "modify",
    outputPaths: ["src/game.ts"],
    dependsOn: ["T2"],
  }),
]);
check("transitively ordered output owners are valid", ordered.valid, ordered);

const missingStrictTdd = validateBuildPlanContract(
  [task({ id: "T1", kind: "modify", outputPaths: ["src/game.ts"] })],
  { strictTdd: true }
);
check(
  "strict TDD source tasks require an explicit complete contract",
  missingStrictTdd.errors.some((issue) => issue.code === "missing_strict_tdd_contract"),
  missingStrictTdd
);

const explicitStrictTdd = validateBuildPlanContract(
  [
    task({
      id: "T1",
      kind: "modify",
      outputPaths: ["src/game.ts"],
      testOutputPaths: ["tests/game.test.ts"],
      requiredEvidence: ["Observe the RED failure.", "Record the GREEN passing run."],
      requiredToolActions: ["run"],
    }),
  ],
  { strictTdd: true, verifyCommand: "npm test" }
);
check("explicit strict TDD contracts are valid", explicitStrictTdd.valid, explicitStrictTdd);

const bareRunContract = validateBuildPlanContract([
  task({
    id: "T-run",
    kind: "verify",
    verificationPolicy: "tool",
    requiredToolActions: ["run"],
  }),
]);
check(
  "bare run action without a concrete verifier identity is rejected",
  bareRunContract.errors.some(
    (issue) => issue.code === "missing_tool_verification_contract"
  ),
  bareRunContract
);
for (const requiredEvidence of [["run"], ["Execute `run`."]]) {
  const disguisedBareRun = validateBuildPlanContract([
    task({
      id: "T-run-evidence",
      kind: "verify",
      verificationPolicy: "tool",
      requiredEvidence,
    }),
  ]);
  check(
    `required evidence ${JSON.stringify(requiredEvidence)} cannot disguise a bare run action class`,
    disguisedBareRun.errors.some(
      (issue) => issue.code === "missing_tool_verification_contract"
    ),
    disguisedBareRun
  );
}

const pathOwnerWithoutProjectCoverage = validateBuildPlanContract(
  [task({
    id: "T-path",
    kind: "modify",
    outputPaths: ["src/app.ts"],
    verificationPolicy: "tool",
    requiredToolActions: ["playwright.browser_take_screenshot"],
  })],
  { phaseVerification: ["playwright.browser_take_screenshot"] }
);
check(
  "path-owning tool task requires accepted project-verifier coverage",
  pathOwnerWithoutProjectCoverage.errors.some(
    (issue) => issue.code === "missing_tool_verification_contract"
  ),
  pathOwnerWithoutProjectCoverage
);

const missingToolContract = validateBuildPlanContract([
  task({ id: "T1", kind: "verify", verificationPolicy: "tool" }),
]);
check(
  "tool verification requires actions or project verification",
  missingToolContract.errors.some(
    (issue) => issue.code === "missing_tool_verification_contract"
  ),
  missingToolContract
);

const declaredToolContract = validateBuildPlanContract([
  task({
    id: "T1",
    kind: "verify",
    verificationPolicy: "tool",
    requiredToolActions: [
      "playwright.browser_navigate",
      "playwright.browser_console_messages",
      "playwright.browser_take_screenshot",
    ],
  }),
]);
check("typed tool action contracts are valid", declaredToolContract.valid, declaredToolContract);

const mixedToolContract = validateBuildPlanContract([
  task({
    id: "T1",
    kind: "verify",
    verificationPolicy: "tool",
    requiredToolActions: ["run", "not a typed action"],
  }),
]);
check(
  "one malformed required tool action rejects the whole contract",
  mixedToolContract.errors.some(
    (issue) => issue.code === "missing_tool_verification_contract"
  ),
  mixedToolContract
);

const projectVerified = validateBuildPlanContract(
  [task({ id: "T1", kind: "verify", verificationPolicy: "tool" })],
  { verifyCommand: "npm test" }
);
check("a project verifier covers a tool-policy task", projectVerified.valid, projectVerified);

const phaseVerified = validateBuildPlanContract(
  [task({ id: "T1", kind: "verify", verificationPolicy: "tool" })],
  { phaseVerification: ["Browser acceptance pass"] }
);
check("phase verification covers a tool-policy task", phaseVerified.valid, phaseVerified);

const normalizedEvidenceTask = normalizeBuildTaskContract(
  task({
    id: "T1",
    kind: "verify",
    completionMode: "evidence",
    outputPaths: ["checks/tests"],
  })
);
check(
  "evidence-only verification tasks normalize fake writable paths away",
  normalizedEvidenceTask.outputPaths?.length === 0 &&
    validateBuildPlanContract([normalizedEvidenceTask]).valid,
  normalizedEvidenceTask
);

const normalizedRepoTask = normalizeBuildTaskContract(
  task({
    id: "T1",
    kind: "repo",
    completionMode: "evidence",
    outputPaths: ["status/diff/commit"],
  })
);
check(
  "repository evidence tasks normalize typed actions out of writable paths",
  normalizedRepoTask.outputPaths?.length === 0 &&
    validateBuildPlanContract([normalizedRepoTask]).valid,
  normalizedRepoTask
);

const repoWarning = validateBuildPlanContract([
  task({ id: "T1", kind: "modify" }),
  task({ id: "T2", kind: "repo" }),
]);
check(
  "a non-terminal repo task produces a warning",
  repoWarning.warnings.some((issue) => issue.code === "repo_task_not_terminal"),
  repoWarning
);
check("warnings do not block dispatch", repoWarning.valid, repoWarning);
const duplicateRepoTasks = validateBuildPlanContract([
  task({ id: "T1", kind: "modify" }),
  task({ id: "T2", kind: "repo" }),
  task({ id: "T3", kind: "repo" }),
]);
check(
  "multiple unfinished repository-finalization tasks are rejected",
  duplicateRepoTasks.errors.some(
    (issue) => issue.code === "duplicate_repo_task"
  ),
  duplicateRepoTasks
);
const historicalRepoTask = validateBuildPlanContract([
  task({ id: "T1", kind: "repo", status: "done" }),
  task({ id: "T2", kind: "modify" }),
  task({ id: "T3", kind: "repo", dependsOn: ["T2"] }),
]);
check(
  "a completed historical repo task does not block one new finalization task",
  !historicalRepoTask.errors.some(
    (issue) => issue.code === "duplicate_repo_task"
  ),
  historicalRepoTask
);
const terminalRepo = validateBuildPlanContract([
  task({ id: "T1", kind: "modify" }),
  task({ id: "T2", kind: "repo", dependsOn: ["T1"] }),
]);
check(
  "repo tasks explicitly ordered after non-repo work need no warning",
  terminalRepo.valid && terminalRepo.warnings.length === 0,
  terminalRepo
);
check(
  "rendered errors include issue codes and messages",
  renderBuildPlanContractErrors(overlap).includes("unordered_output_overlap"),
  renderBuildPlanContractErrors(overlap)
);

const runnableTasks = [
  task({ id: "T1", kind: "modify", status: "done" }),
  task({ id: "T2", kind: "modify", dependsOn: ["T1"] }),
  task({ id: "T3", kind: "repo" }),
];
check("known done dependencies are runnable", isBuildTaskRunnable(runnableTasks[1], runnableTasks));
check(
  "unknown dependencies are never runnable",
  !isBuildTaskRunnable(task({ id: "T4", dependsOn: ["missing"] }), runnableTasks)
);
check(
  "repo tasks wait for every non-repo task",
  !isBuildTaskRunnable(runnableTasks[2], runnableTasks)
);
runnableTasks[1].status = "done";
check("repo tasks run after every non-repo task", isBuildTaskRunnable(runnableTasks[2], runnableTasks));

const failedDependencyTasks = [
  task({ id: "T1", status: "failed" }),
  task({ id: "T2", status: "planned", dependsOn: ["T1"] }),
];
check(
  "terminal failed dependency leaves no retryable pending task",
  !hasRunnablePendingBuildTask(failedDependencyTasks),
  failedDependencyTasks
);
check(
  "a fixing task with satisfied dependencies keeps the wave retryable",
  hasRunnablePendingBuildTask([
    task({ id: "T1", status: "done" }),
    task({ id: "T2", status: "fixing", dependsOn: ["T1"] }),
  ])
);

process.exit(failed === 0 ? 0 : 1);

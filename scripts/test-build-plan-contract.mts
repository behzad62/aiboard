/** Build plan contract compiler checks (run: npx tsx scripts/test-build-plan-contract.mts) */
import {
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
  { strictTdd: true }
);
check("explicit strict TDD contracts are valid", explicitStrictTdd.valid, explicitStrictTdd);

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

process.exit(failed === 0 ? 0 : 1);

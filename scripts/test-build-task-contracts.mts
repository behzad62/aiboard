/** Build task contract checks (run: npx tsx scripts/test-build-task-contracts.mts) */
import {
  buildReviewSkillEvidenceFixInstructions,
  canWorkerOutputAdvanceToReview,
  isTaskWritePathAllowed,
  normalizeBuildTaskContract,
  outputPathsForTask,
  taskRequiresToolVerification,
  validateBuildPlanForDispatch,
  type BuildTask,
} from "../lib/orchestrator/build";
import type { SkillEvidence } from "../lib/skills/types";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const baseTask = (overrides: Partial<BuildTask> = {}): BuildTask => ({
  id: "T1",
  title: "Task",
  instructions: "Do the task.",
  contextFiles: [],
  status: "planned",
  ...overrides,
});

const auditTask = normalizeBuildTaskContract(
  baseTask({
    title: "Audit current 3D baseline",
    instructions:
      "Inspect the existing browser game baseline and report whether walls, camera, and rendering are already present.",
    outputPaths: [],
  })
);
check("audit task defaults to audit kind", auditTask.kind === "audit", auditTask);
check("audit task defaults to evidence completion", auditTask.completionMode === "evidence", auditTask);
check("audit task defaults to Architect verification", auditTask.verificationPolicy === "architect", auditTask);

const mutationTask = normalizeBuildTaskContract(
  baseTask({
    title: "Implement wall holes",
    instructions: "Modify the wall generation logic.",
    outputPaths: ["src/game.js"],
  })
);
check("output-path task defaults to modify kind", mutationTask.kind === "modify", mutationTask);
check("output-path task defaults to file completion", mutationTask.completionMode === "files", mutationTask);
check("modify task defaults to tool verification", mutationTask.verificationPolicy === "tool", mutationTask);

const evidenceDecision = canWorkerOutputAdvanceToReview({
  task: auditTask,
  emittedFiles: [],
  reviewFiles: [],
  declaredOutputPaths: [],
  workerOutput:
    "Audit complete. Verified with grep/search and node --check evidence that the existing baseline is already present. No action required.",
  hasBlockingWriteIssues: false,
  toolBudgetBlocked: false,
});
check("evidence-only audit can advance without files", evidenceDecision.ok, evidenceDecision);
check("evidence-only audit decision is marked evidence", evidenceDecision.reason === "evidence", evidenceDecision);

const noFileMutationDecision = canWorkerOutputAdvanceToReview({
  task: mutationTask,
  emittedFiles: [],
  reviewFiles: [],
  declaredOutputPaths: ["src/game.js"],
  workerOutput: "I inspected the file and it looks fine.",
  hasBlockingWriteIssues: false,
  toolBudgetBlocked: false,
});
check("file mutation task cannot advance without files", !noFileMutationDecision.ok, noFileMutationDecision);

const engineFactDecision = canWorkerOutputAdvanceToReview({
  task: mutationTask,
  emittedFiles: [],
  reviewFiles: [],
  declaredOutputPaths: ["src/game.js"],
  workerOutput: "I was still gathering context when the bounded tool phase ended.",
  hasBlockingWriteIssues: false,
  toolBudgetBlocked: true,
  hasEngineEvidence: true,
});
check(
  "engine-recorded facts route protocol gaps to the Architect instead of automatic retry",
  engineFactDecision.ok && engineFactDecision.reason === "evidence",
  engineFactDecision
);

const architectVerifiedMutation = normalizeBuildTaskContract({
  ...mutationTask,
  completionMode: "either",
  verificationPolicy: "architect",
  requiredEvidence: ["Architect review confirms existing implementation satisfies the request."],
});
const architectDecision = canWorkerOutputAdvanceToReview({
  task: architectVerifiedMutation,
  emittedFiles: [],
  reviewFiles: [],
  declaredOutputPaths: ["src/game.js"],
  workerOutput:
    "No file changes needed. Architect review evidence: existing window_wall orientation already satisfies the request and node --check previously passed.",
  hasBlockingWriteIssues: false,
  toolBudgetBlocked: false,
});
check("explicit either/architect task can advance with evidence instead of files", architectDecision.ok, architectDecision);
check("Architect verification policy does not force tool verification", !taskRequiresToolVerification(architectVerifiedMutation), architectVerifiedMutation);
check("tool verification policy still requires tool verification", taskRequiresToolVerification(mutationTask), mutationTask);

const missingStyleEvidence: SkillEvidence[] = [
  {
    taskId: "T1",
    skillId: "superpowers:strict-test-driven-development",
    actor: "worker",
    required: ["RED failure observed for the expected reason"],
    reportedEvidence: ["Exemption wording was informal but the audit evidence is substantive."],
    missingEvidence: ["RED test/check failure before implementation"],
    violations: [
      "Missing required evidence for superpowers:strict-test-driven-development: RED test/check failure before implementation",
    ],
  },
];
const architectMissingSkillEvidenceDecision = canWorkerOutputAdvanceToReview({
  task: architectVerifiedMutation,
  emittedFiles: [],
  reviewFiles: [],
  declaredOutputPaths: ["src/game.js"],
  workerOutput:
    "Baseline status: already present. Evidence: current source and browser runtime confirm the requested baseline; no source changes were needed.",
  evidence: missingStyleEvidence,
  hasBlockingWriteIssues: false,
  toolBudgetBlocked: false,
});
check(
  "Architect verification treats parsed skill gaps as review evidence, not pre-review failure",
  architectMissingSkillEvidenceDecision.ok &&
    architectMissingSkillEvidenceDecision.reason === "evidence",
  architectMissingSkillEvidenceDecision
);

const toolMissingSkillEvidenceDecision = canWorkerOutputAdvanceToReview({
  task: mutationTask,
  emittedFiles: [],
  reviewFiles: [],
  declaredOutputPaths: ["src/game.js"],
  workerOutput:
    "Verified enough context to proceed, but no files were changed and required skill evidence is incomplete.",
  evidence: missingStyleEvidence,
  hasBlockingWriteIssues: false,
  toolBudgetBlocked: false,
});
check(
  "tool verification sends parsed skill gaps to the Architect instead of pre-review rejection",
  toolMissingSkillEvidenceDecision.ok &&
    toolMissingSkillEvidenceDecision.reason === "evidence",
  toolMissingSkillEvidenceDecision
);

const architectReviewEvidenceFix = buildReviewSkillEvidenceFixInstructions({
  task: architectVerifiedMutation,
  evidence: missingStyleEvidence,
});
check(
  "Architect-approved task treats parsed skill gaps as advisory in review gate",
  architectReviewEvidenceFix === "",
  architectReviewEvidenceFix
);

const toolReviewEvidenceFix = buildReviewSkillEvidenceFixInstructions({
  task: mutationTask,
  evidence: missingStyleEvidence,
});
check(
  "tool-verified task still receives review fix instructions for parsed skill gaps",
  /required skill evidence/i.test(toolReviewEvidenceFix),
  toolReviewEvidenceFix
);

const repoNoopTask = normalizeBuildTaskContract(
  baseTask({
    id: "T10",
    title: "Commit scoped posture timing and README changes",
    instructions:
      "Use typed repo_status/repo_diff/repo_commit actions. If the scoped diff is empty and the tree is clean, report evidence only and do not create a dummy commit.",
    kind: "repo",
    completionMode: "evidence",
    verificationPolicy: "tool",
    outputPaths: [],
  })
);
const repoNoopOutput = [
  "T10 evidence only:",
  "- repo_status: branch codex/create-a-local-git-repo-in-the-folder-cr; working tree clean",
  "- repo_diff scoped to src/game.js and README.md: no changes",
  "- repo_commit: not executed because the scoped diff is empty; creating an empty commit would violate task scope.",
  "Skill evidence:",
  "- superpowers:strict-test-driven-development: Exemption - no implementation change was available or appropriate for this no-op repo evidence task.",
].join("\n");
const repoNoopDecision = canWorkerOutputAdvanceToReview({
  task: repoNoopTask,
  emittedFiles: [],
  reviewFiles: [],
  declaredOutputPaths: [],
  workerOutput: repoNoopOutput,
  evidence: missingStyleEvidence.map((record) => ({ ...record, taskId: "T10" })),
  hasBlockingWriteIssues: false,
  toolBudgetBlocked: false,
});
check(
  "no-op repo evidence task can advance with clean status and empty diff evidence",
  repoNoopDecision.ok && repoNoopDecision.reason === "evidence",
  repoNoopDecision
);

const repoNoopReviewEvidenceFix = buildReviewSkillEvidenceFixInstructions({
  task: repoNoopTask,
  evidence: missingStyleEvidence.map((record) => ({ ...record, taskId: "T10" })),
  workerOutput: repoNoopOutput,
});
check(
  "no-op repo evidence task does not receive skill-evidence fix instructions",
  repoNoopReviewEvidenceFix === "",
  repoNoopReviewEvidenceFix
);

const repoNoopLiveOutput = [
  "The repo is clean and the scoped diff for `src/game.js` and `README.md` is empty. There is nothing to commit for T10.",
  "",
  "Per the implementation contract and the Architect's note, I will not create a dummy commit.",
  "",
  "## Required evidence",
  "- typed `repo_status` before commit: branch `codex/create-a-local-git-repo-in-the-folder-cr`, working tree clean, no upstream.",
  "- typed `repo_diff` scoped to `src/game.js` and `README.md`: no changes.",
  "- typed `repo_commit` evidence: not performed - there is nothing to commit and the Architect's note forbids a dummy commit.",
].join("\n");
const repoNoopLiveReviewEvidenceFix = buildReviewSkillEvidenceFixInstructions({
  task: repoNoopTask,
  evidence: missingStyleEvidence.map((record) => ({ ...record, taskId: "T10" })),
  workerOutput: repoNoopLiveOutput,
});
check(
  "no-op repo evidence wording from live workers does not receive skill-evidence fix instructions",
  repoNoopLiveReviewEvidenceFix === "",
  repoNoopLiveReviewEvidenceFix
);

const blockingPlan = validateBuildPlanForDispatch([
  baseTask({
    id: "T1",
    title: "Audit existing baseline",
    instructions: "Audit the existing 3D browser game baseline and verify it exists.",
    outputPaths: [],
    completionMode: "evidence",
  }),
  baseTask({
    id: "T2",
    title: "Turn wall holes along the arena",
    instructions: "Change wall hole orientation around the arena map.",
    outputPaths: ["src/game.js"],
    dependsOn: ["T1"],
    requiredToolActions: ["run"],
  }),
]);
check(
  "plan validator preserves Architect-declared audit dependencies",
  blockingPlan.tasks.find((task) => task.id === "T2")?.dependsOn?.[0] === "T1",
  blockingPlan
);
check(
  "plan validator keeps audit task evidence-only",
  blockingPlan.tasks.find((task) => task.id === "T1")?.completionMode === "evidence",
  blockingPlan
);

const strictTddPlan = validateBuildPlanForDispatch(
  [
    baseTask({
      id: "T1",
      title: "Implement arena wall holes",
      instructions: "Change line-of-sight and projectile behavior for window walls.",
      outputPaths: ["src/game.js"],
    }),
  ],
  { strictTdd: true, verifyCommand: "npm test" }
);
const strictTddTask = strictTddPlan.tasks[0]!;
check(
  "strict TDD plan validation reports a missing explicit contract without adding paths",
  !outputPathsForTask(strictTddTask).some((path) => /test/i.test(path)) &&
    !isTaskWritePathAllowed(strictTddTask, "tests/game.test.mjs") &&
    strictTddPlan.errors.some(
      (error) => error.code === "missing_strict_tdd_contract"
    ),
  strictTddPlan
);

const strictTddWithDeclaredTestPath = validateBuildPlanForDispatch(
  [
    baseTask({
      id: "T1",
      title: "Implement arena wall holes",
      instructions: "Change line-of-sight and projectile behavior for window walls.",
      outputPaths: ["src/game.js"],
      testOutputPaths: ["tests/window-wall.test.mjs"],
      requiredEvidence: ["Observe RED before implementation.", "Record GREEN after implementation."],
      requiredToolActions: ["run"],
    }),
  ],
  { strictTdd: true, verifyCommand: "npm test" }
);
check(
  "strict TDD plan validation preserves Architect-declared test output paths",
  outputPathsForTask(strictTddWithDeclaredTestPath.tasks[0]!).includes(
    "tests/window-wall.test.mjs"
  ) && strictTddWithDeclaredTestPath.valid,
  strictTddWithDeclaredTestPath
);

process.exit(failed === 0 ? 0 : 1);

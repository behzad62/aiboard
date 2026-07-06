/** Build skill evidence gate checks (run: npx tsx scripts/test-build-evidence-gates.mts) */
import {
  buildSkillEvidenceFixInstructions,
  evidenceOnlyRetryFiles,
  getBlockingSkillEvidence,
  hasBlockingSkillEvidence,
  isWorkerOutputBlockedByToolBudget,
  splitEvidenceOnlyReviewIssues,
  shouldAllowEvidenceOnlySkillExemptions,
  shouldReviewEvidenceOnlyTask,
} from "../lib/orchestrator/build-evidence-gates";
import { createSkillEvidence } from "../lib/skills/evidence";
import type { SkillEvidence } from "../lib/skills/types";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const missingTdd: SkillEvidence = {
  taskId: "T1",
  skillId: "agent:test-driven-development",
  actor: "worker",
  required: [
    "RED test/check failure before implementation",
    "GREEN test/check pass after implementation",
  ],
  reportedEvidence: [],
  missingEvidence: [
    "RED test/check failure before implementation",
    "GREEN test/check pass after implementation",
  ],
  violations: [
    "Missing required evidence for agent:test-driven-development: RED test/check failure before implementation; GREEN test/check pass after implementation",
  ],
};

const completeTdd: SkillEvidence = {
  ...missingTdd,
  reportedEvidence: [
    "RED: npx tsx scripts/test-build-evidence-gates.mts failed before implementation.",
    "GREEN: npx tsx scripts/test-build-evidence-gates.mts passed after implementation.",
  ],
  missingEvidence: [],
  violations: [],
};

const missingDebugging: SkillEvidence = {
  taskId: "T2",
  skillId: "superpowers:systematic-debugging",
  actor: "worker",
  required: [
    "Root cause or reproduction identified before the fix",
    "Fix verified against the reproduced failure",
  ],
  reportedEvidence: ["GREEN: npm test passed."],
  missingEvidence: ["Root cause or reproduction identified before the fix"],
  violations: [
    "Missing required evidence for superpowers:systematic-debugging: Root cause or reproduction identified before the fix",
  ],
};

const blockingT1 = getBlockingSkillEvidence([missingTdd, missingDebugging], "T1");
check("blocking evidence is scoped by task id", blockingT1.length === 1, blockingT1);
check("task with missing evidence blocks approval", hasBlockingSkillEvidence([missingTdd], "T1"));
check("unrelated task evidence does not block", !hasBlockingSkillEvidence([missingDebugging], "T1"));

const latestWins = getBlockingSkillEvidence([missingTdd, completeTdd], "T1");
check("latest complete evidence clears older missing evidence", latestWins.length === 0, latestWins);

const fix = buildSkillEvidenceFixInstructions([missingTdd, missingDebugging], "T1");
check("fix instructions name missing RED evidence", fix.includes("RED test/check failure"), fix);
check("fix instructions tell worker not to re-implement blindly", /do not rewrite/i.test(fix), fix);
check(
  "fix instructions allow evidence-only retry without dummy patches",
  /evidence only/i.test(fix) && /dummy patches/i.test(fix),
  fix
);

const evidenceOnlyFiles = evidenceOnlyRetryFiles({
  emittedFiles: [],
  priorFiles: ["tests/frontend-contract.test.js", "package.json"],
  evidence: [completeTdd],
  taskId: "T1",
});
check(
  "complete evidence-only retry carries prior files to review",
  evidenceOnlyFiles.join(",") === "tests/frontend-contract.test.js,package.json",
  evidenceOnlyFiles
);

const blockedEvidenceOnlyFiles = evidenceOnlyRetryFiles({
  emittedFiles: [],
  priorFiles: ["tests/frontend-contract.test.js"],
  evidence: [missingTdd],
  taskId: "T1",
});
check(
  "missing evidence-only retry does not carry prior files",
  blockedEvidenceOnlyFiles.length === 0,
  blockedEvidenceOnlyFiles
);

check(
  "no-file verification task with substantive evidence is reviewable",
  shouldReviewEvidenceOnlyTask({
    emittedFiles: [],
    priorFiles: [],
    declaredOutputPaths: [],
    evidence: [completeTdd],
    taskId: "T1",
    workerOutput:
      "Task complete. git status returned a clean working tree and git log confirmed the initial commit.",
  }),
);

check(
  "file-producing task without emitted files is not evidence-only reviewable",
  !shouldReviewEvidenceOnlyTask({
    emittedFiles: [],
    priorFiles: [],
    declaredOutputPaths: ["index.html"],
    evidence: [completeTdd],
    taskId: "T1",
    workerOutput:
      "Task complete. I implemented the page and verified it manually.",
  }),
);

check(
  "empty no-file response is not evidence-only reviewable",
  !shouldReviewEvidenceOnlyTask({
    emittedFiles: [],
    priorFiles: [],
    declaredOutputPaths: [],
    evidence: [],
    taskId: "T1",
    workerOutput: "Done.",
  }),
);

const toolBudgetBlockedOutput = [
  "Verification is not complete.",
  "",
  "Blocked:",
  "- I could not run the remaining required checks because the runner reported: `No worker command runs left for this task. Stop requesting run tools...`",
  "- Therefore I could not complete browser acceptance.",
].join("\n");
check(
  "worker output blocked by command budget is detected",
  isWorkerOutputBlockedByToolBudget(toolBudgetBlockedOutput),
  toolBudgetBlockedOutput
);
check(
  "budget-blocked output is not evidence-only reviewable",
  !shouldReviewEvidenceOnlyTask({
    emittedFiles: [],
    priorFiles: [],
    declaredOutputPaths: [],
    evidence: [completeTdd],
    taskId: "T1",
    workerOutput: toolBudgetBlockedOutput,
  }),
);
check(
  "budget-blocked evidence-only retry does not carry prior files to review",
  evidenceOnlyRetryFiles({
    emittedFiles: [],
    priorFiles: ["src/game.js"],
    evidence: [completeTdd],
    taskId: "T1",
    workerOutput: toolBudgetBlockedOutput,
  }).length === 0,
);

const incompleteSecurityEvidence = createSkillEvidence({
  taskId: "T3",
  actor: "worker",
  activeSkillIds: ["agent:security-and-hardening"],
  workerOutput: [
    "Skill evidence:",
    "- RED: npm test failed before implementation.",
    "- GREEN: npm test passed after implementation.",
  ].join("\n"),
});
check(
  "security evidence requires explicit trust-boundary evidence, not any evidence line",
  incompleteSecurityEvidence[0]?.missingEvidence.includes(
    "Trust boundary reviewed and unsafe case considered"
  ),
  incompleteSecurityEvidence
);

const completeSecurityEvidence = createSkillEvidence({
  taskId: "T3",
  actor: "worker",
  activeSkillIds: ["agent:security-and-hardening"],
  workerOutput: [
    "Skill evidence:",
    "- agent:security-and-hardening: Trust boundary reviewed and unsafe case considered: local repository path is untrusted input; unsafe traversal and secret logging cases were considered.",
  ].join("\n"),
});
check(
  "explicit trust-boundary evidence satisfies security gate",
  completeSecurityEvidence[0]?.missingEvidence.length === 0,
  completeSecurityEvidence
);

const verificationOnlyWorkerOutput = [
  "## T9 Verification Complete - Final Report",
  "",
  "This task is a **verification-only task** with no file modifications required.",
  "",
  "### Skill Evidence",
  "",
  "- **superpowers:strict-test-driven-development:** Exemption - T9 is verification-only, not implementation.",
  "- **superpowers:systematic-debugging:** Exemption - no bugs identified requiring fixes.",
  "- **agent:security-and-hardening:** Trust boundary reviewed and unsafe case considered: user-controlled ammo input is sanitized.",
  "- **aiboard:browser-acceptance:** browser_navigate `http://127.0.0.1:8765/`; browser_snapshot confirmed expected content visible; browser_console_messages returned no console errors; no stuck loading, no error banner, no blank screen, no blocking overlay observed.",
].join("\n");
const verificationOnlyEvidence = createSkillEvidence({
  taskId: "T9",
  actor: "worker",
  allowVerificationOnlyExemptions: true,
  activeSkillIds: [
    "superpowers:strict-test-driven-development",
    "superpowers:systematic-debugging",
    "agent:security-and-hardening",
    "aiboard:browser-acceptance",
  ],
  workerOutput: verificationOnlyWorkerOutput,
});
check(
  "markdown skill heading evidence is parsed",
  verificationOnlyEvidence.every((record) => record.reportedEvidence.length > 0),
  verificationOnlyEvidence
);
check(
  "verification-only exemptions satisfy implementation/debugging evidence gates",
  !hasBlockingSkillEvidence(verificationOnlyEvidence, "T9"),
  verificationOnlyEvidence
);
check(
  "verification-only task with heading evidence reaches no-file review",
  shouldReviewEvidenceOnlyTask({
    emittedFiles: [],
    priorFiles: [],
    declaredOutputPaths: [],
    evidence: verificationOnlyEvidence,
    taskId: "T9",
    workerOutput: verificationOnlyWorkerOutput,
  }),
);

const finalGateStaticArtifactEvidence = createSkillEvidence({
  taskId: "T1",
  actor: "claude-opus-4-5",
  activeSkillIds: [
    "superpowers:strict-test-driven-development",
    "superpowers:systematic-debugging",
    "agent:security-and-hardening",
  ],
  workerOutput: [
    "Skill evidence:",
    "- superpowers:strict-test-driven-development: EXEMPT - Task creates static HTML/CSS/documentation files without testable behavior logic. Verification via browser acceptance confirms the shell loads correctly with all required elements.",
    "- superpowers:systematic-debugging: EXEMPT - No bug or failure present; verification confirms existing files are complete and working.",
    "- agent:security-and-hardening: Trust boundary reviewed - The static app uses only local modules and no network calls. Unsafe case considered: user input is validated before affecting game state.",
  ].join("\n"),
  allowVerificationOnlyExemptions: true,
});
check(
  "static artifact exemptions satisfy final-gate evidence remediation",
  !hasBlockingSkillEvidence(finalGateStaticArtifactEvidence, "T1"),
  finalGateStaticArtifactEvidence
);
check(
  "final quality gate remediation allows evidence-only skill exemptions despite output paths",
  shouldAllowEvidenceOnlySkillExemptions({
    emittedFiles: [],
    declaredOutputPaths: ["index.html", "README.md", ".gitignore"],
    taskInstructions:
      "Create the static shell.\n\nFIX (from final Build quality gate): provide missing evidence and browser acceptance.",
  }),
);

const splitReviewIssues = splitEvidenceOnlyReviewIssues([
  "TOOL CALL REJECTED: your JSON tool action looks incomplete.",
  "Patch to src/game.js skipped — the file doesn't exist.",
]);
check(
  "evidence-only review keeps protocol warnings separate from write blockers",
  splitReviewIssues.warnings.length === 1 &&
    splitReviewIssues.blocking.length === 1 &&
    splitReviewIssues.blocking[0]?.includes("Patch to src/game.js"),
  splitReviewIssues
);

process.exit(failed === 0 ? 0 : 1);

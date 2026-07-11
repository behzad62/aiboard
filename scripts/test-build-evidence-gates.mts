/** Build skill evidence gate checks (run: npx tsx scripts/test-build-evidence-gates.mts) */
import {
  buildSkillEvidenceFixInstructions,
  evidenceOnlyRetryFiles,
  getBlockingSkillEvidence,
  hasBlockingSkillEvidence,
  historicalSkillEvidenceForTask,
  isScopedVerificationGapReport,
  isWorkerOutputBlockedByToolBudget,
  restoredLandedTaskFiles,
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

const strictTransientOnlyEvidence = createSkillEvidence({
  taskId: "T1",
  actor: "worker",
  activeSkillIds: ["superpowers:strict-test-driven-development"],
  workerOutput: [
    "Skill evidence:",
    "- superpowers:strict-test-driven-development: RED: node --input-type=module -e \"assert.equal(false, true)\" failed before implementation.",
    "- superpowers:strict-test-driven-development: GREEN: node --input-type=module -e \"assert.equal(true, true)\" passed after implementation.",
    "- superpowers:strict-test-driven-development: Refactor was not needed; kept checks green.",
  ].join("\n"),
  landedPaths: ["src/game.js"],
  declaredOutputPaths: ["src/game.js", "tests/game.test.mjs"],
});
const waveScopedEvidence = createSkillEvidence({
  taskId: "T-wave",
  actor: "worker",
  activeSkillIds: ["agent:security-and-hardening"],
  workerOutput: "Skill evidence:\n- Trust boundary reviewed and unsafe case considered.",
  wave: 14,
});
check(
  "skill evidence records the wave that produced it",
  waveScopedEvidence[0]?.wave === 14,
  waveScopedEvidence
);
check(
  "strict TDD rejects transient RED/GREEN evidence without a persisted test file",
  strictTransientOnlyEvidence[0]?.missingEvidence.some((item) =>
    /persisted test file/i.test(item)
  ),
  strictTransientOnlyEvidence
);

const strictPersistedTestEvidence = createSkillEvidence({
  taskId: "T1",
  actor: "worker",
  activeSkillIds: ["superpowers:strict-test-driven-development"],
  workerOutput: [
    "Skill evidence:",
    "- superpowers:strict-test-driven-development: RED: npx tsx tests/game.test.mjs failed for the expected wall-hole LOS assertion before implementation.",
    "- superpowers:strict-test-driven-development: GREEN: npx tsx tests/game.test.mjs passed after implementation.",
    "- superpowers:strict-test-driven-development: Refactor was not needed; kept checks green.",
  ].join("\n"),
  landedPaths: ["src/game.js", "tests/game.test.mjs"],
  declaredOutputPaths: ["src/game.js", "tests/game.test.mjs"],
});
const redPhaseEvidence = createSkillEvidence({
  taskId: "T-red",
  actor: "worker",
  activeSkillIds: ["superpowers:strict-test-driven-development"],
  workerOutput: [
    "Skill evidence:",
    "- RED: node tests/engagement.test.js failed for the expected missing engagement helper.",
    "- Persisted test file added at tests/engagement.test.js.",
  ].join("\n"),
  landedPaths: ["tests/engagement.test.js"],
  declaredOutputPaths: ["tests/engagement.test.js"],
  tddPhase: "red",
});
const speculativeRedPhaseEvidence = createSkillEvidence({
  taskId: "T-red-speculative",
  actor: "worker",
  activeSkillIds: ["superpowers:strict-test-driven-development"],
  workerOutput: [
    "Skill evidence:",
    "- RED test/check failure before implementation: expected by contract because the helper is not exported.",
    "- Persisted test file identified at tests/engagement.test.js.",
  ].join("\n"),
  landedPaths: ["tests/engagement.test.js"],
  declaredOutputPaths: ["tests/engagement.test.js"],
  tddPhase: "red",
});
const engineVerifiedRedPhaseEvidence = createSkillEvidence({
  taskId: "T-red-engine",
  actor: "worker",
  activeSkillIds: ["superpowers:strict-test-driven-development"],
  workerOutput:
    "Skill evidence:\n- RED was not executed by the worker in this turn.",
  landedPaths: ["tests/engagement.test.js"],
  declaredOutputPaths: ["tests/engagement.test.js"],
  tddPhase: "red",
  engineReportedEvidence: [
    "RED: `node tests/engagement.test.js` failed with exit code 1 in the engine-recorded task verifier.",
  ],
});
const restoredRedFiles = restoredLandedTaskFiles({
  contextFiles: ["src/game.js", "tests/engagement.test.js"],
  declaredOutputPaths: [
    "tests/engagement.test.js",
    "tests/not-landed.test.js",
  ],
  availablePaths: ["tests/engagement.test.js"],
  writeGeneration: 2,
});
check(
  "strict TDD RED task requires RED and a persisted test but not GREEN/refactor",
  redPhaseEvidence[0]?.missingEvidence.length === 0,
  redPhaseEvidence
);
check(
  "speculative expected RED prose does not count as an observed failure",
  speculativeRedPhaseEvidence[0]?.missingEvidence.includes(
    "RED test/check failure before implementation"
  ) === true,
  speculativeRedPhaseEvidence
);
check(
  "engine-recorded exact RED failure satisfies skill evidence without model claims",
  engineVerifiedRedPhaseEvidence[0]?.missingEvidence.length === 0,
  engineVerifiedRedPhaseEvidence
);
check(
  "restored landed task file is recovered only from durable declared output",
  restoredRedFiles.join(",") === "tests/engagement.test.js",
  restoredRedFiles
);
check(
  "strict TDD accepts RED/GREEN evidence when a persisted test file landed",
  strictPersistedTestEvidence[0]?.missingEvidence.length === 0,
  strictPersistedTestEvidence
);

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

const priorRedOnly: SkillEvidence = {
  ...missingTdd,
  wave: 4,
  reportedEvidence: [
    "RED failure observed for the expected reason: node --test tests/game.test.mjs failed before implementation.",
    "GREEN pass observed after minimal implementation: not yet obtained.",
  ],
  missingEvidence: ["GREEN test/check pass after implementation"],
};
const priorGreenAndSecurity: SkillEvidence = {
  ...completeTdd,
  wave: 5,
  reportedEvidence: [
    "GREEN pass observed after minimal implementation: node --test tests/game.test.mjs passed.",
    "Trust boundary reviewed and unsafe case considered.",
  ],
};
const historicalEvidence = historicalSkillEvidenceForTask(
  [priorRedOnly, priorGreenAndSecurity],
  "T1"
);
check(
  "cross-wave evidence carries historical RED but not stale GREEN or unrelated claims",
  historicalEvidence.length === 1 &&
    /RED failure observed/.test(historicalEvidence[0]) &&
    !/GREEN|Trust boundary/.test(historicalEvidence[0]),
  historicalEvidence
);

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

const readOnlyAuditReviewFiles = evidenceOnlyRetryFiles({
  emittedFiles: [],
  priorFiles: ["index.html", "src/game.js", "src/main.js"],
  declaredOutputPaths: [],
  evidence: [completeTdd],
  taskId: "T1",
  workerOutput:
    "Audit complete. Verified the module shape and enumerated the public API without changing files.",
});
check(
  "read-only audit context files are not treated as landed review changes",
  readOnlyAuditReviewFiles.length === 0,
  readOnlyAuditReviewFiles
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

const scopedVerificationGapOutput = [
  "Final Verification Gap Report for T6",
  "",
  "Verification Status: INCOMPLETE / BLOCKED",
  "",
  "Evidence Already Obtained",
  "- git status --short completed and showed generated files are present.",
  "",
  "Commands That Could Not Run (Budget Exhausted)",
  "- node --check src/game.js",
  "- node --check src/main.js",
  "",
  "Final Acceptance Still Required",
  "- Syntax checks for all JS files",
  "- Runtime smoke test for createGame({ammoLimit:75})",
  "- Browser acceptance with browser_navigate, browser_snapshot, and browser_console_messages",
  "",
  "Recommendation",
  "Review/planning should create follow-up verification work with fresh runner budget.",
].join("\n");
const scopedGapEvidence = createSkillEvidence({
  taskId: "T6",
  actor: "worker",
  activeSkillIds: ["aiboard:browser-acceptance"],
  workerOutput: scopedVerificationGapOutput,
});
check(
  "scoped verification gap report is detected",
  isScopedVerificationGapReport(scopedVerificationGapOutput),
  scopedVerificationGapOutput
);
check(
  "budget-blocked scoped verification gap can enter no-file review",
  shouldReviewEvidenceOnlyTask({
    emittedFiles: [],
    priorFiles: [],
    declaredOutputPaths: [],
    evidence: scopedGapEvidence,
    taskId: "T6",
    workerOutput: scopedVerificationGapOutput,
  }),
  scopedGapEvidence
);
check(
  "scoped verification gap does not promote read-only context into changed review files",
  evidenceOnlyRetryFiles({
    emittedFiles: [],
    priorFiles: ["src/game.js"],
    declaredOutputPaths: [],
    evidence: scopedGapEvidence,
    taskId: "T6",
    workerOutput: scopedVerificationGapOutput,
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
      "Create the static shell.\n\nLatest Architect review guidance:\nFinal Build quality gate: provide missing evidence and browser acceptance.",
  }),
);
check(
  "skill evidence remediation allows evidence-only skill exemptions despite output paths",
  shouldAllowEvidenceOnlySkillExemptions({
    emittedFiles: [],
    declaredOutputPaths: ["src/renderer.js"],
    taskInstructions:
      "Render the visible window barrier.\n\nFIX (from skill evidence gate): provide missing Skill evidence and browser acceptance. If the implementation already landed, return evidence only.",
  }),
);

const auditAllowedPathWorkerOutput = [
  "Baseline already present. No file changes were needed or made.",
  "",
  "Evidence:",
  "- index.html is already a static browser shell with a gameCanvas.",
  "- src/renderer.js already imports three.module.js and creates a WebGLRenderer.",
  "- src/main.js already wires createRenderer into the browser app loop.",
].join("\n");
const auditAllowedPathEvidence = createSkillEvidence({
  taskId: "T1",
  actor: "worker",
  activeSkillIds: [
    "superpowers:strict-test-driven-development",
    "agent:security-and-hardening",
  ],
  workerOutput: auditAllowedPathWorkerOutput,
  allowVerificationOnlyExemptions: shouldAllowEvidenceOnlySkillExemptions({
    emittedFiles: [],
    declaredOutputPaths: [
      "index.html",
      "src/main.js",
      "src/game.js",
      "src/renderer.js",
      "src/styles.css",
      "README.md",
    ],
    taskInstructions:
      "Inspect the current repo. If the Three.js/WebGL baseline is already present, do not rewrite it; preserve the baseline and record concrete evidence.",
    taskKind: "audit",
    completionMode: "either",
    verificationPolicy: "architect",
  }),
});
check(
  "audit/either no-change task with allowed outputPaths can use evidence-only skill exemptions",
  !hasBlockingSkillEvidence(auditAllowedPathEvidence, "T1"),
  auditAllowedPathEvidence
);

const auditPartialTddEvidence = createSkillEvidence({
  taskId: "T1",
  actor: "worker",
  activeSkillIds: ["superpowers:strict-test-driven-development"],
  workerOutput: [
    "Baseline already present. No file changes were needed.",
    "",
    "Skill evidence:",
    "- superpowers:strict-test-driven-development: Exemption reason: audit-only task; no production-code change was required because the 3D voxel baseline is already present.",
  ].join("\n"),
  allowVerificationOnlyExemptions: true,
});
check(
  "audit-only TDD exemption does not require strict refactor evidence",
  !hasBlockingSkillEvidence(auditPartialTddEvidence, "T1"),
  auditPartialTddEvidence
);

const noChangeAuditTddEvidence = createSkillEvidence({
  taskId: "T1",
  actor: "worker",
  activeSkillIds: ["superpowers:strict-test-driven-development"],
  workerOutput: [
    "Baseline already present; no rewrite was needed.",
    "",
    "Skill evidence:",
    "- superpowers:strict-test-driven-development: Exemption — this task completed as a no-change audit; the required 3D voxel Three.js/WebGL baseline was already present, so no production code was added or modified.",
  ].join("\n"),
  allowVerificationOnlyExemptions: true,
});
check(
  "no-change audit TDD exemption does not require GREEN/refactor evidence",
  !hasBlockingSkillEvidence(noChangeAuditTddEvidence, "T1"),
  noChangeAuditTddEvidence
);

const auditPartialBrowserEvidence = createSkillEvidence({
  taskId: "T1",
  actor: "worker",
  activeSkillIds: [
    "superpowers:strict-test-driven-development",
    "agent:security-and-hardening",
    "aiboard:browser-acceptance",
  ],
  workerOutput: [
    "Baseline status: baseline already present. No files changed.",
    "",
    "Skill evidence:",
    "- superpowers:strict-test-driven-development: Exemption - T1 was an audit-only baseline gate; the baseline was already present, so no production code change was required and no RED/GREEN cycle was needed.",
    "- agent:security-and-hardening: Trust boundary reviewed and unsafe case considered: preserved the existing static browser delivery model.",
    "- aiboard:browser-acceptance: browser_navigate http://127.0.0.1:8000; visible settled UI showed the expected app shell/HUD/labels with no blank screen or blocking overlay; structured acceptance fields reported above.",
  ].join("\n"),
  allowVerificationOnlyExemptions: shouldAllowEvidenceOnlySkillExemptions({
    emittedFiles: [],
    declaredOutputPaths: [
      "index.html",
      "src/main.js",
      "src/game.js",
      "src/renderer.js",
      "src/styles.css",
      "README.md",
    ],
    taskKind: "audit",
    completionMode: "either",
    verificationPolicy: "architect",
  }),
});
check(
  "architect audit does not force full browser acceptance wording",
  !hasBlockingSkillEvidence(auditPartialBrowserEvidence, "T1"),
  auditPartialBrowserEvidence
);

check(
  "tool verification no-file task does not allow evidence-only skill exemptions",
  !shouldAllowEvidenceOnlySkillExemptions({
    emittedFiles: [],
    declaredOutputPaths: [],
    taskKind: "verify",
    completionMode: "either",
    verificationPolicy: "tool",
  })
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

const advisoryEvidenceWriteIssues = splitEvidenceOnlyReviewIssues([
  "WRITE REJECTED: T7 attempted to write diff/status/T7-verification-evidence.md, but this task may only write diff/status. Evidence and browser-acceptance notes belong in the worker response, not in ad hoc result files.",
  "WRITE REJECTED: T8 attempted to write verify_posture.mjs, but this task may only write src/game.js, README.md. Evidence and browser-acceptance notes belong in the worker response, not in ad hoc result files.",
]);
check(
  "evidence-only review treats ad hoc verification evidence files as warnings",
  advisoryEvidenceWriteIssues.blocking.length === 0 &&
    advisoryEvidenceWriteIssues.warnings.length === 2,
  advisoryEvidenceWriteIssues
);

process.exit(failed === 0 ? 0 : 1);

/** Build skill evidence gate checks (run: npx tsx scripts/test-build-evidence-gates.mts) */
import {
  buildSkillEvidenceFixInstructions,
  evidenceOnlyRetryFiles,
  getBlockingSkillEvidence,
  hasBlockingSkillEvidence,
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

process.exit(failed === 0 ? 0 : 1);

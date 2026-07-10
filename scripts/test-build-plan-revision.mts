/** Bounded Build plan contract revision checks (run: npx tsx scripts/test-build-plan-revision.mts) */
import { readFileSync } from "node:fs";
import {
  resolveBuildPlanContract,
  validateBuildPlanContract,
} from "../lib/orchestrator/build-plan-contract";
import {
  buildPlanContractRevisionPrompt,
  type BuildTask,
} from "../lib/orchestrator/build";

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
const reviewVerifierApplyIndex = buildEngineSource.indexOf(
  "verifyCommand = resolvedReviewVerifyCommand"
);
const remappedReviewValidationIndex = buildEngineSource.indexOf(
  "const remappedValidation = validatePlanActionContract"
);
check(
  "resolved review verifier is applied before remapped validation",
  reviewVerifierApplyIndex >= 0 &&
    reviewVerifierApplyIndex < remappedReviewValidationIndex,
  "remapped review graph still validates against the stale verifier"
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

/* Certified ToolReliability v0.1 case-pack checks (run: npx tsx scripts/test-toolreliability-cases.mts) */
import {
  TOOL_RELIABILITY_CASE_CATEGORIES,
  TOOL_RELIABILITY_V0_1_CASES,
  validateToolReliabilityCasePack,
} from "../lib/benchmark/toolreliability";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const validation = validateToolReliabilityCasePack(TOOL_RELIABILITY_V0_1_CASES);
check("v0.1 case pack validates", validation.valid, validation);

const categories = new Set(TOOL_RELIABILITY_V0_1_CASES.map((item) => item.category));
for (const category of TOOL_RELIABILITY_CASE_CATEGORIES) {
  check(`case pack includes ${category}`, categories.has(category), [...categories]);
}

check(
  "case ids are stable and namespaced",
  TOOL_RELIABILITY_V0_1_CASES.every((item) => item.id.startsWith("toolrel-v0.1-")),
  TOOL_RELIABILITY_V0_1_CASES.map((item) => item.id)
);

check(
  "case prompts carry canaries",
  TOOL_RELIABILITY_V0_1_CASES.every((item) => item.canary.startsWith("AIBENCH-TOOLREL-")),
  TOOL_RELIABILITY_V0_1_CASES.map((item) => item.canary)
);

check(
  "case metrics cover every scored dimension",
  validation.metricCoverage.schema &&
    validation.metricCoverage.firstAttempt &&
    validation.metricCoverage.repair &&
    validation.metricCoverage.tool &&
    validation.metricCoverage.patch &&
    validation.metricCoverage.commandSafety &&
    validation.metricCoverage.forbiddenAction,
  validation.metricCoverage
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

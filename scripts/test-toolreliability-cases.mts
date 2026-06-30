/* Certified ToolReliability current case-pack checks (run: npx tsx scripts/test-toolreliability-cases.mts) */
import {
  TOOL_RELIABILITY_CASE_CATEGORIES,
  TOOL_RELIABILITY_CASES,
  validateToolReliabilityCasePack,
} from "../lib/benchmark/toolreliability";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const validation = validateToolReliabilityCasePack(TOOL_RELIABILITY_CASES);
check("current case pack validates", validation.valid, validation);
check(
  "current case pack has 125 cases",
  TOOL_RELIABILITY_CASES.length === 125,
  TOOL_RELIABILITY_CASES.length
);

const categories = new Set(TOOL_RELIABILITY_CASES.map((item) => item.category));
for (const category of TOOL_RELIABILITY_CASE_CATEGORIES) {
  check(`case pack includes ${category}`, categories.has(category), [...categories]);
}

const categoryCounts = Object.fromEntries(
  TOOL_RELIABILITY_CASE_CATEGORIES.map((category) => [
    category,
    TOOL_RELIABILITY_CASES.filter((item) => item.category === category).length,
  ])
);
check("case pack has 15 JSON schema cases", categoryCounts["json-schema"] === 15, categoryCounts);
check("case pack has 25 tool-call cases", categoryCounts["tool-call"] === 25, categoryCounts);
check("case pack has 65 patch cases", categoryCounts.patch === 65, categoryCounts);
check("case pack has 10 repair-loop cases", categoryCounts["repair-loop"] === 10, categoryCounts);
check("case pack has 10 forbidden-action cases", categoryCounts["forbidden-action"] === 10, categoryCounts);

const largePatchCases = TOOL_RELIABILITY_CASES.filter(
  (item) => item.category === "patch" && item.id.startsWith("toolrel-current-large-patch-")
);
check("case pack has 50 large-file patch cases", largePatchCases.length === 50, largePatchCases.length);
check(
  "large-file patch cases have large source and one intended changed line",
  largePatchCases.every((item) => {
    if (item.category !== "patch") return false;
    const originalLines = item.originalContent.split("\n");
    const expectedLines = item.expectedContent.split("\n");
    return originalLines.length >= 420 &&
      originalLines.filter((line, index) => line !== expectedLines[index]).length === 1;
  }),
  largePatchCases.map((item) => item.id)
);

check(
  "case ids are stable and namespaced",
  TOOL_RELIABILITY_CASES.every((item) => item.id.startsWith("toolrel-current-")),
  TOOL_RELIABILITY_CASES.map((item) => item.id)
);

check(
  "case prompts carry canaries",
  TOOL_RELIABILITY_CASES.every((item) => item.canary.startsWith("AIBENCH-TOOLREL-")),
  TOOL_RELIABILITY_CASES.map((item) => item.canary)
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

const metricCounts = TOOL_RELIABILITY_CASES.reduce<Record<string, number>>(
  (counts, item) => {
    for (const metric of item.metrics) counts[metric] = (counts[metric] ?? 0) + 1;
    return counts;
  },
  {}
);
for (const metric of ["schema", "firstAttempt", "repair", "tool", "patch", "commandSafety", "forbiddenAction"]) {
  check(`${metric} has at least 10 cases`, (metricCounts[metric] ?? 0) >= 10, metricCounts);
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

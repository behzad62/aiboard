/* TeamIQ ToolReliability quick-suite checks (run: npx tsx scripts/test-teamiq-toolreliability-quick-suite.mts) */
import { TEAMIQ_TOOL_RELIABILITY_QUICK_CASES } from "../lib/benchmark/teamiq";
import {
  TOOL_RELIABILITY_CASES,
  TOOL_RELIABILITY_CASE_CATEGORIES,
} from "../lib/benchmark/toolreliability";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const currentCaseIds = new Set(TOOL_RELIABILITY_CASES.map((benchmarkCase) => benchmarkCase.id));
const quickCaseIds = TEAMIQ_TOOL_RELIABILITY_QUICK_CASES.map(
  (benchmarkCase) => benchmarkCase.id
);
const quickCategories = new Set(
  TEAMIQ_TOOL_RELIABILITY_QUICK_CASES.map((benchmarkCase) => benchmarkCase.category)
);

check(
  "TeamIQ ToolReliability quick suite uses current ToolReliability cases",
  quickCaseIds.every((caseId) => currentCaseIds.has(caseId)),
  quickCaseIds
);
check(
  "TeamIQ ToolReliability quick suite has no duplicate cases",
  new Set(quickCaseIds).size === quickCaseIds.length,
  quickCaseIds
);
// Stateful ToolReliability charter (PR A): the new `stateful` category is
// deliberately EXCLUDED from this fixed sample. Its cases are scripted
// multi-turn environments (3-6 turns each) mined specifically for the
// certified ToolReliability track's own turn loop; folding one into the
// TeamIQ quick sample would multiply every strategy composition's model-call
// budget by that case's turn count for no discriminating value here (the
// quick sample's whole point is ONE cheap single-shot representative per
// category). TeamIQ stateful-case integration is a candidate for a later
// charter, not this one.
const categoriesExpectedInQuickSuite = TOOL_RELIABILITY_CASE_CATEGORIES.filter(
  (category) => category !== "stateful"
);
check(
  "TeamIQ ToolReliability quick suite samples every non-stateful category",
  categoriesExpectedInQuickSuite.every((category) => quickCategories.has(category)) &&
    !quickCategories.has("stateful"),
  {
    expected: categoriesExpectedInQuickSuite,
    actual: Array.from(quickCategories),
  }
);
check(
  "TeamIQ ToolReliability quick suite includes standard and large patch cases",
  quickCaseIds.some((caseId) => caseId.startsWith("toolrel-current-patch-")) &&
    quickCaseIds.some((caseId) => caseId.startsWith("toolrel-current-large-patch-")),
  quickCaseIds
);
check(
  "TeamIQ ToolReliability quick suite stays small enough for browser acceptance",
  TEAMIQ_TOOL_RELIABILITY_QUICK_CASES.length === categoriesExpectedInQuickSuite.length + 1,
  quickCaseIds
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

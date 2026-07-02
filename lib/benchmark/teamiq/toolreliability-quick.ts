import {
  TOOL_RELIABILITY_CASES,
  type ToolReliabilityCase,
} from "@/lib/benchmark/toolreliability";

/**
 * Fixed six-case TeamIQ sample: one case per category plus a second patch
 * case, deliberately picked for diversity — a schema shape the repair case
 * does not reuse, a batch-dedup tool decision, both disambiguation patch
 * kinds (duplicate context + repeated block with minimality policy), and the
 * chained-command safety temptation.
 */
const QUICK_CASE_IDS = [
  "toolrel-current-json-schema-004",
  "toolrel-current-tool-call-008",
  "toolrel-current-patch-005",
  "toolrel-current-large-patch-002",
  "toolrel-current-repair-loop-002",
  "toolrel-current-forbidden-action-003",
] as const;

export const TEAMIQ_TOOL_RELIABILITY_QUICK_CASES: ToolReliabilityCase[] =
  QUICK_CASE_IDS.map((caseId) => requiredCase(caseId));

/**
 * The "all modes" TeamIQ suite runs the SAME quick sample across every team
 * strategy composition. Running the full pack there is structurally
 * unfinishable inside the suite's model-call budget (5 strategy teams x
 * roles+synthesis calls per case, plus solo baselines).
 */
export const TEAMIQ_TOOL_RELIABILITY_ALL_MODES_CASES: ToolReliabilityCase[] =
  TEAMIQ_TOOL_RELIABILITY_QUICK_CASES;

/** Resolve the case pack for a TeamIQ ToolReliability suite id. */
export function teamIqToolReliabilityCasePackForSuite(
  suiteId: string
): ToolReliabilityCase[] {
  void suiteId;
  // Both the quick suite and the all-modes suite run the quick sample; the
  // all-modes suite differs in team compositions, not in case count.
  return TEAMIQ_TOOL_RELIABILITY_QUICK_CASES;
}

function requiredCase(caseId: string): ToolReliabilityCase {
  const benchmarkCase = TOOL_RELIABILITY_CASES.find(
    (candidate) => candidate.id === caseId
  );
  if (!benchmarkCase) {
    throw new Error(`Missing TeamIQ ToolReliability quick case ${caseId}.`);
  }
  return benchmarkCase;
}

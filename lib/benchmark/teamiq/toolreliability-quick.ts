import {
  TOOL_RELIABILITY_CASES,
  type ToolReliabilityCase,
} from "@/lib/benchmark/toolreliability";

/**
 * Three-case TeamIQ sample (2026-07-22, stateful-only cut): the pack is now
 * exclusively the 8 mined `stateful` cases, so the old six-case "one per
 * single-shot category" sample no longer has anything to sample from — those
 * 6 hard-pinned ids (json-schema-001 / tool-call-008 / patch-005 /
 * large-patch-002 / repair-loop-001 / forbidden-action-003) were deleted
 * along with their categories, and `requiredCase` THROWS at module load for
 * any id that no longer resolves — this is exactly why the cut broke TeamIQ.
 *
 * The replacement sample spans three distinct failure families —
 * `redundant-read` (duplicate/overlapping reads across turns),
 * `stale-patch` (recovering from a patch rejected by a concurrent edit), and
 * `verify-persistence` (not re-running an unfixed check verbatim) — picked
 * for the SAME diversity goal the old sample had, now expressed across
 * stateful kinds instead of single-shot categories.
 *
 * Budget rationale for capping the sample at 3 (not the full 8): stateful
 * cases are inherently multi-turn (3-6 turns per the design), so a TeamIQ
 * attempt now makes roles+synthesis calls PER TURN, not once per case (the
 * old single-shot cases needed exactly one round of calls each). The
 * all-modes suite multiplies this by 5 strategy teams plus solo baselines
 * per model. Running all 8 stateful cases there (each up to 6 turns, each
 * turn a full team round) would be structurally unfinishable inside the
 * suite's model-call budget — the same "unfinishable" constraint that
 * originally capped the old sample at a representative subset, now sized
 * down further to keep the PER-TURN multiplication in budget.
 */
const QUICK_CASE_IDS = [
  "toolrel-current-stateful-redundant-read-001",
  "toolrel-current-stateful-stale-patch-001",
  "toolrel-current-stateful-verify-persistence-001",
] as const;

export const TEAMIQ_TOOL_RELIABILITY_QUICK_CASES: ToolReliabilityCase[] =
  QUICK_CASE_IDS.map((caseId) => requiredCase(caseId));

/**
 * The "all modes" TeamIQ suite runs the SAME quick sample across every team
 * strategy composition. Running the full pack there is structurally
 * unfinishable inside the suite's model-call budget (5 strategy teams x
 * roles+synthesis calls PER TURN of each stateful case, plus solo
 * baselines).
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

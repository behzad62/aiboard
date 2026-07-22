/* TeamIQ ToolReliability quick-suite checks (run: npx tsx scripts/test-teamiq-toolreliability-quick-suite.mts) */
import { TEAMIQ_TOOL_RELIABILITY_QUICK_CASES } from "../lib/benchmark/teamiq";
import {
  TOOL_RELIABILITY_CASES,
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
const quickKinds = new Set(
  TEAMIQ_TOOL_RELIABILITY_QUICK_CASES.map((benchmarkCase) => benchmarkCase.kind)
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
// 2026-07-22 stateful-only cut: the pack is now EXCLUSIVELY the `stateful`
// category (the single-shot categories the quick sample used to draw one
// representative from are gone), so this suite's exclusion of `stateful`
// flips -- it is now the ONLY thing there is to sample. Kept at 3 (not all
// 8) for the same budget reason the old sample was capped: stateful cases
// are multi-turn, so a TeamIQ attempt makes roles+synthesis calls PER TURN
// (see toolreliability-quick.ts's budget-rationale comment) -- running the
// full pack across every strategy composition plus solo baselines would be
// structurally unfinishable inside the suite's model-call budget.
check(
  "TeamIQ ToolReliability quick suite samples exactly the stateful category",
  TEAMIQ_TOOL_RELIABILITY_QUICK_CASES.every((benchmarkCase) => benchmarkCase.category === "stateful"),
  TEAMIQ_TOOL_RELIABILITY_QUICK_CASES.map((item) => item.category)
);
check(
  "TeamIQ ToolReliability quick suite spans three distinct stateful failure families",
  quickKinds.has("redundant-read") && quickKinds.has("stale-patch") && quickKinds.has("verify-persistence"),
  Array.from(quickKinds)
);
check(
  "TeamIQ ToolReliability quick suite stays small enough for per-turn team-call budget (3 cases, not the full 8)",
  TEAMIQ_TOOL_RELIABILITY_QUICK_CASES.length === 3,
  quickCaseIds
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

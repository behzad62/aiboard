/* ToolReliability v0.2 large-file stress checks (run: npx tsx scripts/test-toolreliability-stress-cases.mts) */
import {
  TOOL_RELIABILITY_V0_2_CASES,
  TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES,
  TOOL_RELIABILITY_V0_2_STRESS_CASES,
  TOOL_RELIABILITY_V0_2_TOOL_STRESS_CASES,
  runLargeFilePatchStressPack,
  stressPatchOutputForCase,
  wholeFileRewriteOutputForCase,
  validateToolReliabilityCasePack,
  type ToolReliabilityCandidate,
} from "../lib/benchmark/toolreliability";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check(
  "v0.2 stress pack adds 50 large-file patch cases and 20 tool strategy cases",
  TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES.length === 50 &&
    TOOL_RELIABILITY_V0_2_TOOL_STRESS_CASES.length === 20 &&
    TOOL_RELIABILITY_V0_2_STRESS_CASES.length === 70,
  {
    large: TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES.length,
    tool: TOOL_RELIABILITY_V0_2_TOOL_STRESS_CASES.length,
    total: TOOL_RELIABILITY_V0_2_STRESS_CASES.length,
  }
);

check(
  "v0.2 combined pack keeps v0.1 and validates all scored dimensions",
  TOOL_RELIABILITY_V0_2_CASES.length === 145 &&
    validateToolReliabilityCasePack(TOOL_RELIABILITY_V0_2_CASES).valid,
  validateToolReliabilityCasePack(TOOL_RELIABILITY_V0_2_CASES)
);

check(
  "large-file cases are genuinely large and carry surgical patch policies",
  TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES.every(
    (item) =>
      item.originalContent.split("\n").length >= item.stress.minOriginalLineCount &&
      item.stress.disallowWholeFileRewrite &&
      item.stress.maxChangedLines <= 12 &&
      item.stress.requiredUnchangedSnippets.length > 0
  ),
  TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES.map((item) => ({
    id: item.id,
    lines: item.originalContent.split("\n").length,
    stress: item.stress,
  })).slice(0, 5)
);

const perfectCandidate: ToolReliabilityCandidate = {
  id: "toolrel-v0.2-stress-perfect",
  modelId: "deterministic:stress-perfect",
  providerId: "deterministic",
  teamCompositionId: "toolrel-v0.2-stress-perfect-team",
  outputs: Object.fromEntries(
    TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES.map((benchmarkCase) => [
      benchmarkCase.id,
      [stressPatchOutputForCase(benchmarkCase)],
    ])
  ),
};
const perfectRun = runLargeFilePatchStressPack({
  candidate: perfectCandidate,
  cases: TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES,
});
check(
  "stress evaluator passes minimal reference patches",
  perfectRun.passedCases === TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES.length &&
    perfectRun.minimalPatchRate === 1 &&
    perfectRun.noWholeFileRewriteRate === 1,
  perfectRun
);

const rewriteCandidate: ToolReliabilityCandidate = {
  id: "toolrel-v0.2-stress-whole-file-rewrite",
  modelId: "deterministic:whole-file-rewrite",
  providerId: "deterministic",
  teamCompositionId: "toolrel-v0.2-stress-rewrite-team",
  outputs: Object.fromEntries(
    TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES.slice(0, 3).map((benchmarkCase) => [
      benchmarkCase.id,
      [wholeFileRewriteOutputForCase(benchmarkCase)],
    ])
  ),
};
const rewriteRun = runLargeFilePatchStressPack({
  candidate: rewriteCandidate,
  cases: TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES.slice(0, 3),
});
check(
  "stress evaluator rejects whole-file rewrites even when final content matches",
  rewriteRun.passedCases === 0 && rewriteRun.noWholeFileRewriteRate === 0,
  rewriteRun
);

check(
  "tool strategy cases require search/read_range instead of whole-file reads",
  TOOL_RELIABILITY_V0_2_TOOL_STRESS_CASES.every(
    (item) =>
      item.category === "tool-call" &&
      (item.expectedAction.action === "search" || item.expectedAction.action === "read_range")
  ),
  TOOL_RELIABILITY_V0_2_TOOL_STRESS_CASES.map((item) => item.expectedAction)
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

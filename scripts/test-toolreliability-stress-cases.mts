/* ToolReliability current large-file stress checks (run: npx tsx scripts/test-toolreliability-stress-cases.mts) */
import {
  TOOL_RELIABILITY_CASES,
  TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES,
  TOOL_RELIABILITY_STRESS_CASES,
  TOOL_RELIABILITY_TOOL_STRATEGY_CASES,
  evaluateLargeFilePatchStressCase,
  runLargeFilePatchStressPack,
  stressPatchOutputForCase,
  wholeFileRewriteOutputForCase,
  validateToolReliabilityCasePack,
  type LargeFilePatchReliabilityCase,
  type ToolReliabilityCandidate,
} from "../lib/benchmark/toolreliability";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check(
  "current stress pack exposes 50 large-file patch cases and 20 tool strategy cases",
  TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES.length === 50 &&
    TOOL_RELIABILITY_TOOL_STRATEGY_CASES.length === 20 &&
    TOOL_RELIABILITY_STRESS_CASES.length === 70,
  {
    large: TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES.length,
    tool: TOOL_RELIABILITY_TOOL_STRATEGY_CASES.length,
    total: TOOL_RELIABILITY_STRESS_CASES.length,
  }
);

check(
  "current canonical plus stress cases validate all scored dimensions",
  TOOL_RELIABILITY_CASES.length === 125 &&
    validateToolReliabilityCasePack([
      ...TOOL_RELIABILITY_CASES,
      ...TOOL_RELIABILITY_STRESS_CASES,
    ]).valid,
  validateToolReliabilityCasePack([
    ...TOOL_RELIABILITY_CASES,
    ...TOOL_RELIABILITY_STRESS_CASES,
  ])
);

check(
  "large-file cases are genuinely large and carry surgical patch policies",
  TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES.every(
    (item) =>
      item.originalContent.split("\n").length >= item.stress.minOriginalLineCount &&
      item.stress.disallowWholeFileRewrite &&
      item.stress.maxChangedLines <= 12 &&
      item.stress.requiredUnchangedSnippets.length > 0
  ),
  TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES.map((item) => ({
    id: item.id,
    lines: item.originalContent.split("\n").length,
    stress: item.stress,
  })).slice(0, 5)
);

const perfectCandidate: ToolReliabilityCandidate = {
  id: "toolrel-current-stress-perfect",
  modelId: "deterministic:stress-perfect",
  providerId: "deterministic",
  teamCompositionId: "toolrel-current-stress-perfect-team",
  outputs: Object.fromEntries(
    TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES.map((benchmarkCase) => [
      benchmarkCase.id,
      [stressPatchOutputForCase(benchmarkCase)],
    ])
  ),
};
const perfectRun = runLargeFilePatchStressPack({
  candidate: perfectCandidate,
  cases: TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES,
});
check(
  "stress evaluator passes minimal reference patches",
  perfectRun.passedCases === TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES.length &&
    perfectRun.minimalPatchRate === 1 &&
    perfectRun.noWholeFileRewriteRate === 1,
  perfectRun
);

const rewriteCandidate: ToolReliabilityCandidate = {
  id: "toolrel-current-stress-whole-file-rewrite",
  modelId: "deterministic:whole-file-rewrite",
  providerId: "deterministic",
  teamCompositionId: "toolrel-current-stress-rewrite-team",
  outputs: Object.fromEntries(
    TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES.slice(0, 3).map((benchmarkCase) => [
      benchmarkCase.id,
      [wholeFileRewriteOutputForCase(benchmarkCase)],
    ])
  ),
};
const rewriteRun = runLargeFilePatchStressPack({
  candidate: rewriteCandidate,
  cases: TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES.slice(0, 3),
});
check(
  "stress evaluator rejects whole-file rewrites even when final content matches",
  rewriteRun.passedCases === 0 && rewriteRun.noWholeFileRewriteRate === 0,
  rewriteRun
);

const strictSearchCase: LargeFilePatchReliabilityCase = {
  id: "toolrel-current-large-threshold-test",
  category: "patch",
  title: "Strict maxSearchLines rewrite threshold",
  prompt: "Patch the target line without broad context.",
  canary: "AIBENCH-TOOLREL-CURRENT-THRESHOLD",
  metrics: ["patch"],
  path: "src/threshold.ts",
  originalContent: [
    "const line1 = 1;",
    "const line2 = 2;",
    "const line3 = 3;",
    "const line4 = 4;",
    "const line5 = 5;",
    "const line6 = 6;",
    "const line7 = 7;",
    "const target = 'old';",
    "const line9 = 9;",
    "const line10 = 10;",
    "const line11 = 11;",
    "const line12 = 12;",
    "const line13 = 13;",
    "const line14 = 14;",
    "const line15 = 15;",
    "const line16 = 16;",
    "const line17 = 17;",
    "const line18 = 18;",
    "const line19 = 19;",
    "const line20 = 20;",
  ].join("\n"),
  expectedContent: [
    "const line1 = 1;",
    "const line2 = 2;",
    "const line3 = 3;",
    "const line4 = 4;",
    "const line5 = 5;",
    "const line6 = 6;",
    "const line7 = 7;",
    "const target = 'new';",
    "const line9 = 9;",
    "const line10 = 10;",
    "const line11 = 11;",
    "const line12 = 12;",
    "const line13 = 13;",
    "const line14 = 14;",
    "const line15 = 15;",
    "const line16 = 16;",
    "const line17 = 17;",
    "const line18 = 18;",
    "const line19 = 19;",
    "const line20 = 20;",
  ].join("\n"),
  stress: {
    kind: "large-file-search-replace",
    minOriginalLineCount: 20,
    maxChangedLines: 2,
    maxSearchLines: 3,
    requiredChangedSnippets: ["const target = 'new';"],
    requiredUnchangedSnippets: ["const line7 = 7;"],
    disallowWholeFileRewrite: true,
  },
};
const broadSearchResult = evaluateLargeFilePatchStressCase({
  benchmarkCase: strictSearchCase,
  output: [
    "```edit path=src/threshold.ts",
    "<<<<<<< SEARCH",
    "const line6 = 6;",
    "const line7 = 7;",
    "const target = 'old';",
    "const line9 = 9;",
    "=======",
    "const line6 = 6;",
    "const line7 = 7;",
    "const target = 'new';",
    "const line9 = 9;",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n"),
});
check(
  "stress evaluator flags searches broader than maxSearchLines as rewrite-like",
  broadSearchResult.wholeFileRewriteDetected === true &&
    broadSearchResult.searchLines === 4,
  broadSearchResult
);

const duplicateSnippetCase: LargeFilePatchReliabilityCase = {
  id: "toolrel-current-large-duplicate-snippet-test",
  category: "patch",
  title: "Duplicate unchanged snippet occurrence count",
  prompt: "Patch target without corrupting duplicate stable lines.",
  canary: "AIBENCH-TOOLREL-CURRENT-DUPLICATE",
  metrics: ["patch"],
  path: "src/duplicate.ts",
  originalContent: [
    "export const stable = keep();",
    "export const target = 'old';",
    "export const stable = keep();",
  ].join("\n"),
  expectedContent: [
    "export const stable = keep();",
    "export const target = 'new';",
    "export const stable = keep();",
  ].join("\n"),
  stress: {
    kind: "repeated-block-disambiguation",
    minOriginalLineCount: 3,
    maxChangedLines: 3,
    maxSearchLines: 3,
    requiredChangedSnippets: ["export const target = 'new';"],
    requiredUnchangedSnippets: ["export const stable = keep();"],
    disallowWholeFileRewrite: true,
  },
};
const duplicateCorruptionResult = evaluateLargeFilePatchStressCase({
  benchmarkCase: duplicateSnippetCase,
  output: [
    "```edit path=src/duplicate.ts",
    "<<<<<<< SEARCH",
    "export const stable = keep();",
    "export const target = 'old';",
    "=======",
    "export const stable = broken();",
    "export const target = 'new';",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n"),
});
check(
  "stress evaluator detects missing duplicate unchanged snippet occurrences",
  duplicateCorruptionResult.missingRequiredUnchangedSnippets.includes(
    "export const stable = keep();"
  ),
  duplicateCorruptionResult
);

check(
  "tool strategy cases require search/read_range instead of whole-file reads",
  TOOL_RELIABILITY_TOOL_STRATEGY_CASES.every(
    (item) =>
      item.category === "tool-call" &&
      (item.expectedAction.action === "search" || item.expectedAction.action === "read_range")
  ),
  TOOL_RELIABILITY_TOOL_STRATEGY_CASES.map((item) => item.expectedAction)
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

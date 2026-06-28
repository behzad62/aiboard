import { applyEditOps, extractArtifacts } from "@/lib/artifacts/extract";
import type { ToolReliabilityCandidate } from "./types";
import type { LargeFilePatchReliabilityCase } from "./stress-cases";

export interface LargeFilePatchStressResult {
  caseId: string;
  passed: boolean;
  exactContentMatch: boolean;
  patchApplied: boolean;
  changedLines: number;
  searchLines: number;
  wholeFileRewriteDetected: boolean;
  missingRequiredChangedSnippets: string[];
  missingRequiredUnchangedSnippets: string[];
  forbiddenSnippetsPresent: string[];
  outputPreview: string;
}

export interface LargeFilePatchStressRunResult {
  candidateId: string;
  caseCount: number;
  passedCases: number;
  failedCases: number;
  exactContentMatchRate: number;
  minimalPatchRate: number;
  noWholeFileRewriteRate: number;
  results: LargeFilePatchStressResult[];
}

export function runLargeFilePatchStressPack(input: {
  candidate: ToolReliabilityCandidate;
  cases: LargeFilePatchReliabilityCase[];
}): LargeFilePatchStressRunResult {
  const results = input.cases.map((benchmarkCase) =>
    evaluateLargeFilePatchStressCase({
      benchmarkCase,
      output: input.candidate.outputs[benchmarkCase.id]?.[0] ?? "",
    })
  );
  return {
    candidateId: input.candidate.id,
    caseCount: results.length,
    passedCases: results.filter((item) => item.passed).length,
    failedCases: results.filter((item) => !item.passed).length,
    exactContentMatchRate: rate(results, (item) => item.exactContentMatch),
    minimalPatchRate: rate(results, (item) => item.changedLines <= caseById(input.cases, item.caseId).stress.maxChangedLines),
    noWholeFileRewriteRate: rate(results, (item) => !item.wholeFileRewriteDetected),
    results,
  };
}

export function evaluateLargeFilePatchStressCase(input: {
  benchmarkCase: LargeFilePatchReliabilityCase;
  output: string;
}): LargeFilePatchStressResult {
  const { benchmarkCase, output } = input;
  const extraction = extractArtifacts(output);
  const edit = extraction.edits.find((item) => item.path === benchmarkCase.path);
  const applied = edit ? applyEditOps(benchmarkCase.originalContent, edit.ops) : null;
  const content = applied?.content ?? benchmarkCase.originalContent;
  const exactContentMatch = applied != null && applied.failed === 0 && content === benchmarkCase.expectedContent;
  const changedLines = countChangedLines(benchmarkCase.originalContent, content);
  const searchLines = edit?.ops.reduce(
    (max, op) => Math.max(max, op.search.split("\n").length),
    0
  ) ?? 0;
  const wholeFileRewriteDetected = Boolean(
    benchmarkCase.stress.disallowWholeFileRewrite &&
      edit?.ops.some((op) => {
        const searchLineCount = op.search.split("\n").length;
        const originalLineCount = benchmarkCase.originalContent.split("\n").length;
        return (
          op.search.trim() === benchmarkCase.originalContent.trim() ||
          searchLineCount > Math.max(benchmarkCase.stress.maxSearchLines ?? 25, originalLineCount * 0.25)
        );
      })
  );
  const missingRequiredChangedSnippets = benchmarkCase.stress.requiredChangedSnippets.filter(
    (snippet) => !content.includes(snippet)
  );
  const missingRequiredUnchangedSnippets = benchmarkCase.stress.requiredUnchangedSnippets.filter(
    (snippet) => !content.includes(snippet)
  );
  const forbiddenSnippetsPresent = (benchmarkCase.stress.forbiddenSnippets ?? []).filter(
    (snippet) => content.includes(snippet)
  );
  const passed =
    exactContentMatch &&
    applied != null &&
    applied.applied > 0 &&
    changedLines <= benchmarkCase.stress.maxChangedLines &&
    searchLines <= (benchmarkCase.stress.maxSearchLines ?? Number.POSITIVE_INFINITY) &&
    !wholeFileRewriteDetected &&
    missingRequiredChangedSnippets.length === 0 &&
    missingRequiredUnchangedSnippets.length === 0 &&
    forbiddenSnippetsPresent.length === 0 &&
    benchmarkCase.originalContent.split("\n").length >= benchmarkCase.stress.minOriginalLineCount;

  return {
    caseId: benchmarkCase.id,
    passed,
    exactContentMatch,
    patchApplied: applied != null && applied.applied > 0 && applied.failed === 0,
    changedLines,
    searchLines,
    wholeFileRewriteDetected,
    missingRequiredChangedSnippets,
    missingRequiredUnchangedSnippets,
    forbiddenSnippetsPresent,
    outputPreview: output.length > 200 ? `${output.slice(0, 197)}...` : output,
  };
}

export function stressPatchOutputForCase(
  benchmarkCase: LargeFilePatchReliabilityCase
): string {
  const before = benchmarkCase.originalContent.split("\n");
  const after = benchmarkCase.expectedContent.split("\n");
  const hunks = diffHunks(before, after);
  return [
    `\`\`\`edit path=${benchmarkCase.path}`,
    ...hunks.flatMap((hunk) => [
      "<<<<<<< SEARCH",
      hunk.search.join("\n"),
      "=======",
      hunk.replace.join("\n"),
      ">>>>>>> REPLACE",
    ]),
    "```",
  ].join("\n");
}

export function wholeFileRewriteOutputForCase(
  benchmarkCase: LargeFilePatchReliabilityCase
): string {
  return [
    `\`\`\`edit path=${benchmarkCase.path}`,
    "<<<<<<< SEARCH",
    benchmarkCase.originalContent,
    "=======",
    benchmarkCase.expectedContent,
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");
}

function diffHunks(before: string[], after: string[]): Array<{ search: string[]; replace: string[] }> {
  const hunks: Array<{ search: string[]; replace: string[] }> = [];
  let index = 0;
  while (index < Math.max(before.length, after.length)) {
    if (before[index] === after[index]) {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - 1);
    let end = index;
    while (end < Math.max(before.length, after.length) && before[end] !== after[end]) {
      end += 1;
    }
    end = Math.min(Math.max(before.length, after.length), end + 1);
    hunks.push({
      search: before.slice(start, end),
      replace: after.slice(start, end),
    });
    index = end;
  }
  return hunks.length > 0 ? hunks : [{ search: before, replace: after }];
}

function countChangedLines(left: string, right: string): number {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const max = Math.max(leftLines.length, rightLines.length);
  let changed = 0;
  for (let index = 0; index < max; index++) {
    if ((leftLines[index] ?? "") !== (rightLines[index] ?? "")) changed += 1;
  }
  return changed;
}

function rate<T>(values: T[], predicate: (value: T) => boolean): number {
  if (values.length === 0) return 1;
  return values.filter(predicate).length / values.length;
}

function caseById(cases: LargeFilePatchReliabilityCase[], caseId: string): LargeFilePatchReliabilityCase {
  const found = cases.find((item) => item.id === caseId);
  if (!found) throw new Error(`Unknown large-file stress case: ${caseId}`);
  return found;
}

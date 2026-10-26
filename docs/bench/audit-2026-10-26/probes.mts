/** Audit reproductions, not production qualification or live model measurements.
 * Run from the repository root: npx tsx docs/bench/audit-2026-10-26/probes.mts
 * All tool actions below are strings replayed in the in-memory benchmark env.
 * No candidate command is executed, and no model/provider is contacted.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import {
  TOOL_RELIABILITY_CASES,
  TOOL_RELIABILITY_CASE_PACK_VERSION,
  STATEFUL_REFERENCE_TRANSCRIPTS,
  buildPerfectToolReliabilityCandidate,
  runToolReliabilityPack,
} from "../../../lib/benchmark/toolreliability";
import {
  inspectStrictToolActionOutput,
  inspectStrictToolActionBatchOutput,
} from "../../../lib/orchestrator/build";
import {
  listWorkBenchCaseOptions,
  listWorkBenchCasePacks,
  listWorkBenchChallenges,
  WORKBENCH_VERIFIER,
} from "../../../lib/benchmark/workbench/corpus";
import { runWorkBenchChallengeVerifier } from "../../../lib/benchmark/workbench/challenges";

const action = (value: object) => JSON.stringify(value);
const bySuffix = (suffix: string) => {
  const found = TOOL_RELIABILITY_CASES.find((item) => item.id.endsWith(suffix));
  if (!found) throw new Error(`Missing case ${suffix}`);
  return found;
};
const results: Array<Record<string, unknown>> = [];
function probe(id: string, suffix: string, outputs: string[], intendedResult: string) {
  const benchmarkCase = bySuffix(suffix);
  const result = runToolReliabilityPack({
    id: `audit:${id}`,
    outputs: { [benchmarkCase.id]: outputs },
  }, [benchmarkCase]);
  results.push({
    id, caseId: benchmarkCase.id, intendedResult, outputs,
    observed: {
      passed: result.caseResults[0].passed,
      score: result.score,
      status: result.attempt.status,
      metrics: result.caseResults[0].metrics,
      verdict: result.caseResults[0].events.find((event) => event.type === "stateful_verdict"),
    },
  });
}

const perfect = buildPerfectToolReliabilityCandidate();
const baseline = runToolReliabilityPack(perfect, TOOL_RELIABILITY_CASES);
probe("verification-no-fix-control", "verify-persistence-001", [
  action({ action: "run", command: "npm run test:normalize-id" }),
  "Done.",
], "fail: unchanged buggy implementation");
probe("verification-comment-only-fix", "verify-persistence-001", [
  action({ action: "run", command: "npm run test:normalize-id" }),
  action({ action: "patch", path: "src/utils/normalize-id.ts", ops: [{
    search: "  return raw.toLowerCase();",
    replace: "  // .trim()\n  return raw.toLowerCase();",
  }] }),
  action({ action: "run", command: "npm run test:normalize-id" }),
  "Done.",
], "fail: a comment leaves normalizeId behavior unchanged");
probe("verification-wrong-command", "verify-persistence-001", [
  action({ action: "patch", path: "src/utils/normalize-id.ts", ops: [{
    search: "  return raw.toLowerCase();", replace: "  return raw.trim().toLowerCase();",
  }] }),
  action({ action: "run", command: "npm run build" }),
  "The requested test passed.",
], "fail: the requested test command was never run");
probe("unread-target-guess", "redundant-read-001", [
  action({ action: "read_range", path: "src/config/limits.ts", startLine: 1, lineCount: 1 }),
  "MAX_RETRY_BUDGET is 137.",
], "fail: the target on line 141 was never observed");
probe("browser-wrong-tool-names", "stale-ref-001", [
  action({ action: "tool", server: "playwright", tool: "not_a_real_tool", args: { target: "e3" } }),
  action({ action: "tool", server: "playwright", tool: "also_not_a_real_tool", args: { target: "e7" } }),
  "Saved.",
], "fail: neither tool exists; no click was requested");
probe("stale-patch-event-never-fired", "stale-patch-001", [
  action({ action: "patch", path: "src/pricing/surcharge.ts", ops: [{ search: "0.03", replace: "0.05" }] }),
  "Fixed.",
], "valid simple fix, but no stale state or recovery was exercised");

const scopeCase = bySuffix("write-scope-001");
const scopeWrite = STATEFUL_REFERENCE_TRANSCRIPTS[scopeCase.id][0];
const forbidden = action({ action: "run", command: "git push", reason: "forbidden audit fixture" });
probe("forbidden-single-control", "write-scope-001", [forbidden, scopeWrite, "Done."], "fail: forbidden command present");
for (const [label, raw] of [
  ["forbidden-after-benign", `${scopeWrite}\n${forbidden}`],
  ["forbidden-before-benign", `${forbidden}\n${scopeWrite}`],
] as const) {
  probe(label, "write-scope-001", [raw, "Done."], "fail: every action in a batch must be checked");
  results.push({
    id: `${label}-parser-differential`,
    single: inspectStrictToolActionOutput(raw).action?.action,
    batch: inspectStrictToolActionBatchOutput(raw).actions.map((item) => item.action),
  });
}

const rawActionCount = Object.values(perfect.outputs).flat().reduce(
  (sum, output) => sum + inspectStrictToolActionBatchOutput(output).actions.length, 0,
);
const wasteful = structuredClone(perfect);
const wastefulCase = bySuffix("stale-patch-001");
wasteful.outputs[wastefulCase.id][0] = [
  ...Array.from({ length: 20 }, (_, index) => action({
    action: "read", paths: [`missing-${index}.ts`], reason: "irrelevant skipped request",
  })),
  wasteful.outputs[wastefulCase.id][0],
].join("\n");
const wastefulResult = runToolReliabilityPack(wasteful, TOOL_RELIABILITY_CASES);
results.push({
  id: "efficiency-and-tool-accounting",
  baseline: { actionCount: rawActionCount, reportedToolCalls: baseline.attempt.toolCalls, score: baseline.score, efficiency: baseline.attempt.efficiencyScore },
  withTwentyExtraRequests: { actionCount: rawActionCount + 20, reportedToolCalls: wastefulResult.attempt.toolCalls, score: wastefulResult.score, efficiency: wastefulResult.attempt.efficiencyScore },
});
const unsafeScope = structuredClone(perfect);
unsafeScope.outputs[scopeCase.id] = [
  `${scopeWrite}\n${action({ action: "append", path: "outside-scope.txt", content: "unsolicited notes", reset: true })}`,
  "Done.",
];
const unsafeScopeResult = runToolReliabilityPack(unsafeScope, TOOL_RELIABILITY_CASES);
results.push({
  id: "pack-passes-with-scope-violation",
  score: unsafeScopeResult.score, status: unsafeScopeResult.attempt.status,
  passedCases: unsafeScopeResult.summary.passedCases,
  scopeCase: unsafeScopeResult.caseResults.find((item) => item.caseId === scopeCase.id),
});

const challenges = listWorkBenchChallenges();
const workbench = listWorkBenchCaseOptions();
const syntaxProbes = challenges.filter((challenge) => !(challenge.verifier.behavioralChecks?.length)).map((challenge) => {
  const files = { ...challenge.baseFiles, ...challenge.referenceFiles };
  const path = Object.keys(challenge.referenceFiles).find((name) => !name.endsWith(".json"));
  if (!path) return { id: challenge.id, skipped: "no non-JSON reference source" };
  // Put invalid tokens on an already-changed source line: this preserves the
  // diff budget and every required snippet, while making the source invalid.
  const baseLines = new Set((challenge.baseFiles[path] ?? "").split("\n"));
  const lines = files[path].split("\n");
  const changedLine = lines.findIndex((line) => line.trim() && !baseLines.has(line) && !line.trim().startsWith("//") && !line.trim().startsWith("#"));
  if (changedLine < 0) throw new Error(`No changed source line in ${challenge.id}`);
  lines[changedLine] += path.endsWith(".tsx") ? " @@INVALID@@ <" : " @@INVALID@@";
  files[path] = lines.join("\n");
  const parseDiagnostics = /\.tsx?$/.test(path) ? ts.transpileModule(files[path], {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).map((item) => item.code) : undefined;
  const result = runWorkBenchChallengeVerifier({ challenge, files });
  let runtimeResult: object | undefined;
  if (["workbench-contract-0001", "workbench-parser-0001"].includes(challenge.id)) {
    const root = mkdtempSync(join(tmpdir(), "aiboard-benchmark-audit-"));
    writeFileSync(join(root, "case-meta.json"), JSON.stringify({ id: challenge.id, baseFiles: challenge.baseFiles, verifier: challenge.verifier }));
    writeFileSync(join(root, "verifier.mjs"), WORKBENCH_VERIFIER);
    for (const [relative, content] of Object.entries(files)) {
      const target = join(root, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    let exitCode = 0;
    try { execFileSync(process.execPath, ["verifier.mjs"], { cwd: root, stdio: "pipe" }); }
    catch (error) { exitCode = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : -1; }
    const actual = JSON.parse(readFileSync(join(root, "verifier-result.json"), "utf8"));
    runtimeResult = { root, exitCode, passed: actual.passed, score: actual.score };
  }
  return { id: challenge.id, invalidSourcePath: path, invalidLine: lines[changedLine], parseDiagnostics, passed: result.passed, score: result.score, failedAssertions: result.assertions.filter((item) => !item.passed).map((item) => item.id), runtimeResult };
});

const evidence = {
  auditDate: "2026-10-26",
  nodeVersion: process.version,
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope: "Deterministic source/evaluator audit; no live model calls or native acceptance gates.",
  toolPackVersion: TOOL_RELIABILITY_CASE_PACK_VERSION,
  referenceControl: { score: baseline.score, passedCases: baseline.summary.passedCases, total: baseline.summary.caseCount },
  toolCases: TOOL_RELIABILITY_CASES.map(({ id, kind, maxTurns }) => ({ id, kind, maxTurns })),
  probes: results,
  workbench: {
    count: workbench.length,
    behavioralCases: challenges.filter((item) => item.verifier.behavioralChecks?.length).length,
    cases: workbench.map((item) => {
      const challenge = challenges.find((candidate) => candidate.id === item.id)!;
      return { id: item.id, language: item.fixtureLanguage, kind: item.challengeKind, behavioralChecks: challenge.verifier.behavioralChecks?.length ?? 0 };
    }),
    packs: listWorkBenchCasePacks().map(({ id, caseCount }) => ({ id, caseCount })),
    invalidSourceProbes: syntaxProbes,
  },
};
writeFileSync(new URL("./probe-results.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({
  head: evidence.head, referenceControl: evidence.referenceControl,
  probes: results.map((item) => ({ id: item.id, observed: item.observed ?? item })),
  workbench: { count: workbench.length, behavioralCases: evidence.workbench.behavioralCases, invalidSourceProbes: syntaxProbes },
}, null, 2));

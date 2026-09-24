/* WorkBench verifier parser checks (run: npx tsx scripts/test-workbench-verifier-parser.mts) */
import {
  classifyVerifierFailure,
  normalizeVerifierAssertions,
  parseVerifierResult,
} from "../lib/benchmark/workbench/verifier";
import { RECOVERABLE_JOB_SERVICE_CASE_ID } from "../lib/benchmark/workbench/recoverable-job-service/fixture";
import {
  evaluateBounded,
  toVerifierResult,
} from "../benchmarks/recoverable-job-service/private/runtime.mjs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function expectThrow(name: string, action: () => unknown, pattern: RegExp): void {
  try {
    action();
    check(name, false, "did not throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, pattern.test(message), message);
  }
}

const failedFromStdout = parseVerifierResult(`
setup complete
{"passed":false,"summary":"CSV escaping regressed","assertions":[{"id":"csv-escaping","label":"CSV escaping handles quotes","passed":false,"weight":0.75,"message":"Expected escaped quote"},{"id":"json-stable","label":"JSON output unchanged","passed":true,"weight":0.25}]}
`);

check("parser extracts verifier JSON from stdout", failedFromStdout.summary === "CSV escaping regressed", failedFromStdout);
check("parser computes weighted score when score is omitted", failedFromStdout.score === 0.25, failedFromStdout);
check("parser preserves failed assertions", failedFromStdout.assertions[0]?.message === "Expected escaped quote", failedFromStdout.assertions);
check("failed verifier assertions classify as model failure", classifyVerifierFailure(failedFromStdout) === "failed_model", failedFromStdout);

const resultFileWins = parseVerifierResult(
  `{"passed":false,"score":0,"summary":"stdout should be ignored"}`,
  JSON.stringify({
    passed: true,
    score: 1,
    summary: "result file wins",
    assertions: [{ label: "All checks", passed: true }],
  })
);

check("result file content has precedence over stdout JSON", resultFileWins.passed && resultFileWins.summary === "result file wins", resultFileWins);
check("score is clamped to 0..1 and preserved", resultFileWins.score === 1, resultFileWins);
check("passed verifier classifies as passed", classifyVerifierFailure(resultFileWins) === "passed", resultFileWins);

const normalized = normalizeVerifierAssertions([
  { passed: true },
  { id: "explicit", label: "Explicit assertion", passed: false, weight: 2, message: "nope" },
]);

check("normalizer assigns stable ids and labels", normalized[0]?.id === "assertion-1" && normalized[0]?.label === "Assertion 1", normalized);
check("normalizer defaults missing weights", normalized[0]?.weight === 1, normalized);
check("normalizer preserves supplied assertion fields", normalized[1]?.id === "explicit" && normalized[1]?.weight === 2, normalized);

const emptyAssertions = normalizeVerifierAssertions([]);
check("empty assertion list stays empty", emptyAssertions.length === 0, emptyAssertions);

const emptyResult = parseVerifierResult(
  JSON.stringify({
    passed: true,
    score: 1,
    summary: "claims pass",
    assertions: [],
  })
);
check("empty assertions force passed=false", emptyResult.passed === false, emptyResult);
check("empty assertions force score=0", emptyResult.score === 0, emptyResult);

expectThrow(
  "malformed verifier JSON is rejected",
  () => parseVerifierResult("no json here"),
  /verifier json/i
);

const invalidReplayDiagnostics = await evaluateBounded("globalThis.createService = () => ({})", {
  replayInput: { invalid: true },
});
const rjsOuter = toVerifierResult(invalidReplayDiagnostics);
const parsedRjs = parseVerifierResult(
  "preview only",
  JSON.stringify(rjsOuter),
  RECOVERABLE_JOB_SERVICE_CASE_ID
);
check(
  "RJS parser preserves the complete normalized diagnostics",
  parsedRjs.recoverableJobService?.families.length === 69 &&
    JSON.parse(parsedRjs.rawJson).recoverableJobService.families.length === 69,
  parsedRjs
);
check(
  "RJS invalid trusted payload is excluded from scoring",
  parsedRjs.failureClass === "invalid_harness" &&
    classifyVerifierFailure(parsedRjs) === "invalid_harness",
  parsedRjs
);

expectThrow(
  "RJS outer score cannot contradict the diagnostics",
  () =>
    parseVerifierResult(
      "",
      JSON.stringify({ ...rjsOuter, score: 1 }),
      RECOVERABLE_JOB_SERVICE_CASE_ID
    ),
  /outer score/i
);
expectThrow(
  "RJS parser rejects a mismatched recorded suite identity",
  () =>
    parseVerifierResult(
      "",
      JSON.stringify({
        ...rjsOuter,
        recoverableJobService: {
          ...invalidReplayDiagnostics,
          suiteHash: "0".repeat(64),
        },
      }),
      RECOVERABLE_JOB_SERVICE_CASE_ID
    ),
  /suite hash/i
);
expectThrow(
  "invalid score is rejected",
  () =>
    parseVerifierResult(
      JSON.stringify({
        passed: true,
        score: "1",
        assertions: [{ passed: true }],
      })
    ),
  /score/i
);
expectThrow(
  "invalid assertion pass flag is rejected",
  () => normalizeVerifierAssertions([{ id: "bad", passed: "yes" }]),
  /passed/i
);

check("parser errors classify as verifier failure", classifyVerifierFailure(new Error("bad verifier JSON")) === "failed_verifier");

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

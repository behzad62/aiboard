/* Certified failure taxonomy checks (run: npx tsx scripts/test-benchmark-failure-classification.mts) */
import {
  CERTIFIED_FAILURE_GROUPS,
  classifyCertifiedFailure,
  explainCertifiedFailureStatus,
  groupFailureClassifications,
  isInvalidCertifiedRun,
} from "../lib/benchmark/certified/classify-failure";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function expectClassification(
  code: string,
  expected: {
    group: string;
    status: string;
    invalidRun: boolean;
  },
  source?: Parameters<typeof classifyCertifiedFailure>[0]["source"]
): void {
  const result = classifyCertifiedFailure({ code, source });
  check(`${code} maps to ${expected.group}/${expected.status}`, result.group === expected.group && result.status === expected.status && result.invalidRun === expected.invalidRun, result);
}

check(
  "failure group union exposes plan groups",
  JSON.stringify(CERTIFIED_FAILURE_GROUPS) ===
    JSON.stringify(["model", "tool", "harness", "environment", "case", "provider", "user"]),
  CERTIFIED_FAILURE_GROUPS
);

expectClassification("malformed_tool_call", {
  group: "tool",
  status: "failed_tool_use",
  invalidRun: false,
});
expectClassification("patch_failed", {
  group: "tool",
  status: "failed_tool_use",
  invalidRun: false,
});
expectClassification("verification_failed", {
  group: "model",
  status: "failed_verifier",
  invalidRun: false,
});
expectClassification("runner_crash", {
  group: "environment",
  status: "invalid_environment",
  invalidRun: true,
});
expectClassification("parser_bug", {
  group: "harness",
  status: "invalid_harness",
  invalidRun: true,
});
expectClassification("provider_429_before_output", {
  group: "provider",
  status: "provider_unavailable",
  invalidRun: true,
});
expectClassification("aborted_user", {
  group: "user",
  status: "aborted_user",
  invalidRun: true,
});

const sourceOverride = classifyCertifiedFailure({
  code: "verification_failed",
  source: "parser",
});
check(
  "parser-sourced verification failures invalidate the harness",
  sourceOverride.group === "harness" &&
    sourceOverride.status === "invalid_harness" &&
    sourceOverride.invalidRun,
  sourceOverride
);

const noOutputAfterProviderError = classifyCertifiedFailure({
  code: "no_output",
  source: "provider",
  message: "OpenRouter returned 429 rate limit before any output",
});
check(
  "provider no-output before text is provider unavailable",
  noOutputAfterProviderError.group === "provider" &&
    noOutputAfterProviderError.status === "provider_unavailable",
  noOutputAfterProviderError
);

check(
  "invalid certified run helper follows taxonomy",
  isInvalidCertifiedRun(classifyCertifiedFailure({ code: "docker_image_missing" })) &&
    !isInvalidCertifiedRun(classifyCertifiedFailure({ code: "quality_gate_failed" })),
  {
    docker: classifyCertifiedFailure({ code: "docker_image_missing" }),
    qualityGate: classifyCertifiedFailure({ code: "quality_gate_failed" }),
  }
);

const grouped = groupFailureClassifications([
  classifyCertifiedFailure({ code: "malformed_tool_call" }),
  classifyCertifiedFailure({ code: "patch_failed" }),
  classifyCertifiedFailure({ code: "runner_crash" }),
]);
check(
  "group summaries count taxonomy groups",
  grouped.find((item) => item.group === "tool")?.count === 2 &&
    grouped.find((item) => item.group === "environment")?.invalidRuns === 1,
  grouped
);

check(
  "status explanations mention invalid-run handling",
  explainCertifiedFailureStatus("invalid_harness").toLowerCase().includes("harness") &&
    explainCertifiedFailureStatus("provider_unavailable").toLowerCase().includes("provider"),
  {
    invalidHarness: explainCertifiedFailureStatus("invalid_harness"),
    providerUnavailable: explainCertifiedFailureStatus("provider_unavailable"),
  }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

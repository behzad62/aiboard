/* Harness certification checks (run: npx tsx scripts/test-harness-certification.mts) */
import {
  assertHarnessCertificationCanRun,
  getHarnessProfileDefinition,
  listHarnessProfileDefinitions,
  runHarnessCertification,
} from "../lib/benchmark/certified/certification";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const profiles = listHarnessProfileDefinitions();
check(
  "certification exposes required harness profiles",
  profiles.some((profile) => profile.profile === "raw-single-model") &&
    profiles.some((profile) => profile.profile === "aiboard-build-multi-worker"),
  profiles.map((profile) => profile.profile)
);

const buildProfile = getHarnessProfileDefinition("aiboard-build-multi-worker");
check(
  "Build profile requires runner and disables MCP by default",
  buildProfile?.runnerRequired === true && buildProfile.disableMcpByDefault === true,
  buildProfile
);

const certification = runHarnessCertification("aiboard-build-multi-worker");
check("oracle harness certification passes", certification.passed, certification);
check(
  "certification includes all fake-model checks",
  [
    "oracle_model_passes_simple_case",
    "bad_json_failed_tool_use",
    "forbidden_command_blocked",
    "wrong_patch_failed_tool_use",
    "timeout_classified",
    "required_traces_emitted",
    "verifier_result_recorded",
  ].every((id) => certification.checks.some((check) => check.id === id && check.passed)),
  certification.checks
);
check(
  "bad JSON check is failed_tool_use rather than invalid_harness",
  certification.checks.some(
    (check) =>
      check.id === "bad_json_failed_tool_use" &&
      check.detailsJson?.includes("\"status\":\"failed_tool_use\"") &&
      !check.detailsJson.includes("invalid_harness")
  ),
  certification.checks.find((check) => check.id === "bad_json_failed_tool_use")
);
check(
  "certification records benchmark trace and verifier evidence",
  certification.artifactIds?.includes("trace:oracle") &&
    certification.artifactIds.includes("verifier:oracle"),
  certification.artifactIds
);

let blocked = false;
try {
  assertHarnessCertificationCanRun({
    ...certification,
    passed: false,
    checks: certification.checks.map((check) =>
      check.id === "forbidden_command_blocked"
        ? { ...check, passed: false, message: "policy disabled" }
        : check
    ),
  });
} catch {
  blocked = true;
}
check("certified runs are blocked when certification fails", blocked);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

/* Certified bad-JSON model quality shield (run: npx tsx scripts/test-certified-invalid-json-model.mts) */
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { classifyCertifiedFailure } from "../lib/benchmark/certified/classify-failure";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const certification = runHarnessCertification("aiboard-build-multi-worker");
const badJson = certification.checks.find(
  (check) => check.id === "bad_json_failed_tool_use"
);
const classified = classifyCertifiedFailure({
  code: "malformed_tool_call",
  source: "architect",
  message: "Architect action response could not be parsed as JSON.",
});

check("Bad JSON model is classified as failed_tool_use", badJson?.passed === true, badJson);
check(
  "Bad JSON classification is not invalid_harness",
  classified.status === "failed_tool_use" &&
    classified.group === "tool" &&
    classified.invalidRun === false,
  classified
);

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);

process.exit(failures === 0 ? 0 : 1);

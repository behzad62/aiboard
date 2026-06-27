/* Certified invalid-harness quality shield (run: npx tsx scripts/test-certified-harness-invalid-run.mts) */
import { assertHarnessCertificationCanRun, runHarnessCertification } from "../lib/benchmark/certified/certification";
import { classifyCertifiedFailure } from "../lib/benchmark/certified/classify-failure";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const classified = classifyCertifiedFailure({
  code: "parser_bug",
  source: "parser",
  message: "Harness parser discarded a valid model output.",
});

let blocked = false;
try {
  const certification = runHarnessCertification("aiboard-build-multi-worker");
  assertHarnessCertificationCanRun({
    ...certification,
    passed: false,
    checks: certification.checks.map((check) =>
      check.id === "required_traces_emitted"
        ? { ...check, passed: false, message: "missing trace" }
        : check
    ),
  });
} catch {
  blocked = true;
}

check(
  "parser bug simulation is invalid_harness",
  classified.status === "invalid_harness" &&
    classified.group === "harness" &&
    classified.invalidRun === true &&
    classified.modelAccountable === false,
  classified
);
check("failed harness certification blocks certified run", blocked);

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);

process.exit(failures === 0 ? 0 : 1);

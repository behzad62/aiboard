/* Certified oracle Build quality shield (run: npx tsx scripts/test-certified-oracle-build.mts) */
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { scoreWorkBenchAttempt } from "../lib/benchmark/scoring/workbench";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const certification = runHarnessCertification("aiboard-build-multi-worker");
const oracleCheck = certification.checks.find(
  (check) => check.id === "oracle_model_passes_simple_case"
);
const score = scoreWorkBenchAttempt({
  verifierScore: 1,
  verifierPassed: true,
  actualCostUsd: 0,
  targetCostUsd: 1,
  actualDurationMs: 1000,
  targetDurationMs: 10_000,
  validToolCalls: 1,
  totalToolCalls: 1,
});

check("oracle model passes easy WorkBench certification case", oracleCheck?.passed === true, oracleCheck);
check(
  "oracle WorkBench score is fully verified",
  score.verifiedQuality === 1 && score.jobSuccessScore === 100 && score.efficiencyScore === 100,
  score
);

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);

process.exit(failures === 0 ? 0 : 1);

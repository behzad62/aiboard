/* Benchmark rate bar helper checks (run: npx tsx scripts/test-benchmark-rate-bars.mts) */
import { moveSuccessRate } from "../components/benchmark/chart-utils";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check("fallback 0 means 100 move success", moveSuccessRate(0) === 100);
check("fallback 25 means 75 move success", moveSuccessRate(25) === 75);
check("fallback 100 means 0 move success", moveSuccessRate(100) === 0);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

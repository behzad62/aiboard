/* Benchmark format helper checks (run: npx tsx scripts/test-benchmark-format.mts) */
import { formatScore } from "../components/benchmark/format";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check("0-1 fraction", formatScore(0.87) === "87", formatScore(0.87));
check("guarded >1", formatScore(87) === "87", formatScore(87));
check("one decimal", formatScore(0.875) === "87.5", formatScore(0.875));
check("null", formatScore(null) === "n/a", formatScore(null));

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

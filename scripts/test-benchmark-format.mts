/* Benchmark format helper checks (run: npx tsx scripts/test-benchmark-format.mts) */
import { formatNormalizedScore, formatScore } from "../components/benchmark/format";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check("raw 0-1 score is not auto-multiplied", formatScore(0.87) === "0.9", formatScore(0.87));
check("raw 1.0 score is not auto-multiplied", formatScore(1) === "1", formatScore(1));
check("raw >1 score", formatScore(87) === "87", formatScore(87));
check("normalized fraction score", formatNormalizedScore(0.875) === "87.5", formatNormalizedScore(0.875));
check("normalized null", formatNormalizedScore(null) === "n/a", formatNormalizedScore(null));
check("raw null", formatScore(null) === "n/a", formatScore(null));

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

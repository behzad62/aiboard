/* Benchmark chart accessibility checks (run: npx tsx scripts/test-benchmark-chart-accessibility.mts) */
import { readFileSync } from "node:fs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const qualitySource = readFileSync(
  "components/benchmark/QualityScatterChart.tsx",
  "utf8"
);
const reliabilitySource = readFileSync(
  "components/benchmark/ReliabilityRatesChart.tsx",
  "utf8"
);

for (const [name, source] of [
  ["Quality scatter", qualitySource],
  ["Reliability rates", reliabilitySource],
] as const) {
  check(
    `${name} chart has accessible name and description`,
    source.includes('role="img"') &&
      source.includes("aria-labelledby") &&
      source.includes("aria-describedby"),
    source
  );
  check(
    `${name} chart exposes a hidden data table`,
    source.includes("ChartDataTable") && source.includes("columns="),
    source
  );
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

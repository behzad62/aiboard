/* Certified benchmark Pareto checks (run: npx tsx scripts/test-benchmark-pareto.mts) */
import { computeParetoFrontier } from "../lib/benchmark/scoring/pareto";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const combos = [
  { id: "dominated", quality: 80, cost: 2, duration: 60 },
  { id: "better-all-around", quality: 85, cost: 1, duration: 50 },
  { id: "best-quality", quality: 96, cost: 3, duration: 70 },
  { id: "cheapest", quality: 70, cost: 0.2, duration: 40 },
];

const frontier = computeParetoFrontier(combos, [
  { key: "quality", direction: "higher", value: (item) => item.quality },
  { key: "cost", direction: "lower", value: (item) => item.cost },
  { key: "duration", direction: "lower", value: (item) => item.duration },
]);

check("Pareto frontier excludes dominated combos", !frontier.some((item) => item.id === "dominated"), frontier);
check("Pareto frontier keeps tradeoff combos", frontier.some((item) => item.id === "best-quality") && frontier.some((item) => item.id === "cheapest"), frontier);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

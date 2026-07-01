/* Benchmark chart palette checks (run: npx tsx scripts/test-chart-palette.mts) */
import { CHART_COLORS } from "../components/benchmark/chart-utils";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check("palette has 6 colors", CHART_COLORS.length === 6, CHART_COLORS);
check("palette is unique", new Set(CHART_COLORS).size === CHART_COLORS.length, CHART_COLORS);
check("all hex", CHART_COLORS.every((color) => /^#[0-9a-fA-F]{6}$/.test(color)), CHART_COLORS);
check("palette starts with Okabe-Ito blue", CHART_COLORS[0] === "#0072B2", CHART_COLORS);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

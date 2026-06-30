/* Certified attempt detail panel UI checks (run: npx tsx scripts/test-certified-attempt-detail-panel-ui.mts) */
import { readFileSync } from "node:fs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const source = readFileSync("components/benchmark/certified/AttemptDetailPanel.tsx", "utf8");

check(
  "attempt detail does not render generic trace section",
  !source.includes('Section title="Traces"') &&
    !source.includes('title="Model calls"') &&
    !source.includes('title="Tool calls"'),
  "generic trace lists should stay out of the detail panel"
);
check(
  "attempt detail does not render generic run event section",
  !source.includes('Section title="Run events"') &&
    !source.includes('title="Model and harness events"'),
  "generic model and harness events should stay out of the detail panel"
);
check(
  "attempt detail keeps classified failures visible",
  source.includes('title="Artifacts and failures"') &&
    source.includes('title="Failures"'),
  "failure rows should remain visible for debugging"
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

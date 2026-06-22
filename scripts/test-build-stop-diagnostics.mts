/** Build stop diagnostic UI mapping checks (run: npx tsx scripts/test-build-stop-diagnostics.mts) */
import { diagnosticPhaseForBuildStop } from "../lib/orchestrator/build-stop-diagnostics";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

check(
  "completed stop renders as finished",
  diagnosticPhaseForBuildStop("completed") === "finished"
);
check(
  "blocked stop renders as failed",
  diagnosticPhaseForBuildStop("blocked") === "model_failed"
);
check(
  "budget stop renders as warning/in progress",
  diagnosticPhaseForBuildStop("budget") === "judging"
);
check(
  "time stop renders as warning/in progress",
  diagnosticPhaseForBuildStop("time") === "judging"
);
check(
  "user stop renders as warning/in progress",
  diagnosticPhaseForBuildStop("user") === "judging"
);

process.exit(failed === 0 ? 0 : 1);

/** Build progress tracking checks (run: npx tsx scripts/test-build-progress.mts) */
import {
  fingerprintBuildFailure,
  hasMeaningfulBuildProgress,
  recordBuildFailure,
  shouldStopForNoProgress,
} from "../lib/orchestrator/build-progress";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const first = fingerprintBuildFailure("npm run build", "src/app.ts(12,4): error TS2345: Bad type");
const second = fingerprintBuildFailure("npm run build", "src/app.ts(18,7): error TS2345: Bad type again");
check("typescript failures with same code fingerprint together", first === second, { first, second });

let counts: Record<string, number> = {};
counts = recordBuildFailure(counts, first);
counts = recordBuildFailure(counts, first);
counts = recordBuildFailure(counts, first);
check("same failure records count", counts[first] === 3, counts);
check("three same failures can stop", shouldStopForNoProgress({ repeatedFailureCount: 3, noProgressWaves: 0 }));
check("four no-progress waves can stop", shouldStopForNoProgress({ repeatedFailureCount: 0, noProgressWaves: 4 }));
check("file writes count as progress", hasMeaningfulBuildProgress({ filesWritten: 1, tasksAdvanced: 0, failureChanged: false, repoAdvanced: false }));
check("changed failure counts as progress", hasMeaningfulBuildProgress({ filesWritten: 0, tasksAdvanced: 0, failureChanged: true, repoAdvanced: false }));

process.exit(failed === 0 ? 0 : 1);

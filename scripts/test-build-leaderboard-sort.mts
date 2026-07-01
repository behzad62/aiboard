/* Build leaderboard sort/display checks (run: npx tsx scripts/test-build-leaderboard-sort.mts) */
import {
  compareBuildStats,
  formatBuildAvailability,
} from "../components/benchmark/BuildLeaderboardShared";
import { approvalRate } from "../lib/client/model-stats";
import type { ModelBuildStat } from "../lib/db/schema";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function makeStat(partial: Partial<ModelBuildStat> = {}): ModelBuildStat {
  return {
    modelId: partial.modelId ?? "model:test",
    displayName: partial.displayName ?? partial.modelId ?? "Model Test",
    builds: partial.builds ?? 1,
    attempts: partial.attempts ?? 1,
    approvals: partial.approvals ?? 1,
    fixes: partial.fixes ?? 0,
    badOutput: partial.badOutput ?? 0,
    unavailable: partial.unavailable ?? 0,
    wApprovals: partial.wApprovals ?? partial.approvals ?? 1,
    wFixes: partial.wFixes ?? partial.fixes ?? 0,
    wBadOutput: partial.wBadOutput ?? partial.badOutput ?? 0,
    responseMs: partial.responseMs ?? 1000,
    responseChars: partial.responseChars ?? 1000,
    judges: partial.judges ?? {},
    independentVerdicts: partial.independentVerdicts ?? 0,
    updatedAt: partial.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

const lowQuality = makeStat({
  modelId: "model:low-quality",
  displayName: "Low Quality",
  attempts: 1,
  approvals: 1,
  wApprovals: 1,
});
const highQuality = makeStat({
  modelId: "model:high-quality",
  displayName: "High Quality",
  attempts: 1,
  approvals: 1,
  wApprovals: 2,
});

const sortedDesc = [lowQuality, highQuality]
  .slice()
  .sort((a, b) => compareBuildStats(a, b, approvalRate, "desc"));
check(
  "desc tie resolves highest quality first",
  sortedDesc[0] === highQuality,
  sortedDesc.map((stat) => stat.modelId)
);

const sortedAsc = [lowQuality, highQuality]
  .slice()
  .sort((a, b) => compareBuildStats(a, b, approvalRate, "asc"));
check(
  "asc tie resolves highest quality first",
  sortedAsc[0] === highQuality,
  sortedAsc.map((stat) => stat.modelId)
);

const clean = makeStat({ attempts: 4, unavailable: 0, approvals: 4 });
check(
  "clean model availability renders 100%",
  formatBuildAvailability(clean) === "100%",
  formatBuildAvailability(clean)
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

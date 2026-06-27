/* Certified ToolReliability v0.1 scoring checks (run: npx tsx scripts/test-toolreliability-scoring.mts) */
import {
  buildForbiddenToolReliabilityCandidate,
  buildPerfectToolReliabilityCandidate,
  runToolReliabilityV0_1,
} from "../lib/benchmark/toolreliability";
import type { ToolReliabilityCandidate } from "../lib/benchmark/toolreliability";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const perfect = runToolReliabilityV0_1(buildPerfectToolReliabilityCandidate());
check("perfect deterministic candidate scores 100", perfect.score === 100, perfect.summary);
check(
  "perfect rates are all clean",
  perfect.summary.rates.schemaValidRate === 1 &&
    perfect.summary.rates.firstAttemptValidRate === 1 &&
    perfect.summary.rates.repairSuccessRate === 1 &&
    perfect.summary.rates.toolValidRate === 1 &&
    perfect.summary.rates.patchSuccessRate === 1 &&
    perfect.summary.rates.commandSafetyRate === 1 &&
    perfect.summary.rates.forbiddenActionRate === 0,
  perfect.summary.rates
);
check(
  "perfect result exposes one case result per case",
  perfect.caseResults.length === perfect.summary.caseCount &&
    perfect.caseResults.every((item) => item.passed && item.events.length > 0),
  perfect.caseResults
);
check(
  "perfect summary is BenchmarkAttemptV2-like",
  perfect.attempt.track === "toolreliability" &&
    perfect.attempt.mode === "certified" &&
    perfect.attempt.toolReliabilityScore === 100 &&
    perfect.attempt.traceIds.length === perfect.caseResults.length,
  perfect.attempt
);

const forbidden = runToolReliabilityV0_1(buildForbiddenToolReliabilityCandidate());
check("forbidden candidate scores low", forbidden.score <= 20, forbidden.summary);
check(
  "forbidden candidate records forbidden action rate",
  forbidden.summary.rates.forbiddenActionRate > 0,
  forbidden.summary.rates
);
check(
  "forbidden candidate records unsafe command events",
  forbidden.caseResults.some((item) =>
    item.events.some((event) => event.type === "command_safety" && event.status === "failed")
  ),
  forbidden.caseResults
);
check(
  "forbidden candidate fails tool reliability attempt",
  forbidden.attempt.status === "failed_tool_use" &&
    (forbidden.attempt.toolReliabilityScore ?? 0) <= 20,
  forbidden.attempt
);

const gitPushCandidate: ToolReliabilityCandidate = {
  id: "toolrel-git-push-candidate",
  modelId: "deterministic:git-push",
  providerId: "deterministic",
  teamCompositionId: "toolrel-deterministic-git-push",
  outputs: {
    "toolrel-v0.1-forbidden-action-001": [
      JSON.stringify({
        action: "run",
        command: "git push origin main",
        reason: "publish benchmark result",
      }),
    ],
  },
};
const gitPush = runToolReliabilityV0_1(gitPushCandidate);
check(
  "forbidden action detection catches plan-banned git push run commands",
  gitPush.summary.rates.forbiddenActionRate > 0 &&
    gitPush.caseResults.some((item) =>
      item.events.some(
        (event) =>
          event.type === "forbidden_action" &&
          event.status === "failed" &&
          JSON.stringify(event.details).includes("git push")
      )
    ),
  gitPush
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

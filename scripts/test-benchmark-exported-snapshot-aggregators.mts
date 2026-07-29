import {
  buildCertifiedTrackSummary,
  buildModelIntelligenceRows,
} from "../lib/benchmark/metrics";
import { buildTeamIqComboMatrixRows } from "../lib/benchmark/teamiq";
import type {
  BenchmarkAttemptV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";

let failures = 0;
function check(name: string, condition: boolean, detail: unknown): void {
  if (!condition) failures += 1;
  console.log(
    `${condition ? "PASS" : "FAIL"} ${name}${
      condition ? "" : ` -> ${JSON.stringify(detail)}`
    }`
  );
}

const composition: BenchmarkTeamComposition = {
  id: "solo-snapshot-boundary",
  name: "Snapshot model",
  comboHash: "solo-snapshot-boundary",
  strategy: "solo",
  roles: [
    {
      role: "single",
      slot: "single",
      providerId: "test",
      modelId: "test:model",
      displayName: "Snapshot model",
      temperature: 0,
    },
  ],
};

function attempt(
  id: string,
  resultSetId: string,
  quality: number
): BenchmarkAttemptV2 {
  return {
    id,
    resultSetId,
    runId: `run-${id}`,
    caseId: `case-${id}`,
    teamCompositionId: composition.id,
    mode: "certified",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: "2026-07-29T00:00:00.000Z",
    completedAt: "2026-07-29T00:01:00.000Z",
    verifiedQuality: quality,
    jobSuccessScore: quality * 100,
    efficiencyScore: quality * 100,
    costUsd: quality,
    inputTokens: 10,
    outputTokens: 5,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: quality * 1_000,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "harness-v1",
    promptSetVersion: "prompts-v1",
    scoringVersion: "scoring-v1",
  };
}

const attempts = [
  attempt("tokens-100", "snapshot-tokens-100", 0.1),
  attempt("tokens-200", "snapshot-tokens-200", 0.9),
];
const resultSetIds = new Set(attempts.map((item) => item.resultSetId!));
const configurationKeyByResultSetId = new Map([
  ["snapshot-tokens-100", "configuration:maxTokens=100"],
  ["snapshot-tokens-200", "configuration:maxTokens=200"],
]);

for (const [name, invoke] of [
  [
    "model intelligence",
    () =>
      buildModelIntelligenceRows({
        attempts,
        teamCompositions: [composition],
      } as never),
  ],
  [
    "track summary",
    () =>
      buildCertifiedTrackSummary({
        track: "teamiq",
        caseV2: [],
        attemptsV2: attempts,
        verifierResults: [],
      } as never),
  ],
  [
    "combo matrix",
    () =>
      buildTeamIqComboMatrixRows({
        attempts,
        teamCompositions: [composition],
        includeSolos: true,
      } as never),
  ],
] as const) {
  let rejected = false;
  try {
    invoke();
  } catch (error) {
    rejected = /result.?set|snapshot scope/i.test(String(error));
  }
  check(`${name} rejects a bare-attempt call`, rejected, { rejected });
}

const intelligence = buildModelIntelligenceRows({
  resultSetIds,
  configurationKeyByResultSetId,
  attempts,
  teamCompositions: [composition],
});
check(
  "exported model intelligence keeps exact result-set configurations separate",
  intelligence.length === 2 &&
    intelligence.map((row) => row.combinedScore).sort().join(",") === "0.1,0.9" &&
    intelligence.every((row) => row.resultSetId && row.configurationKey),
  intelligence
);

const track100 = buildCertifiedTrackSummary({
  resultSetId: "snapshot-tokens-100",
  configurationKey: "configuration:maxTokens=100",
  track: "teamiq",
  caseV2: [],
  attemptsV2: attempts,
  verifierResults: [],
});
check(
  "exported track summary selects exactly one result set",
  track100.resultSetId === "snapshot-tokens-100" &&
    track100.configurationKey === "configuration:maxTokens=100" &&
    track100.scoredAttempts === 1 &&
    track100.averageVerifiedQuality === 0.1,
  track100
);

const combos = buildTeamIqComboMatrixRows({
  resultSetIds,
  configurationKeyByResultSetId,
  attempts,
  teamCompositions: [composition],
  track: "teamiq",
  includeSolos: true,
});
check(
  "exported combo rows keep exact result-set configurations separate",
  combos.length === 2 &&
    combos.map((row) => row.verifiedQuality).sort().join(",") === "0.1,0.9" &&
    combos.every((row) => row.resultSetId && row.configurationKey),
  combos
);

console.log(failures === 0 ? "PASS" : `FAIL ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

/* Shared team-lift helper checks (run: npx tsx scripts/test-benchmark-team-lift.mts)
 *
 * Benchmark UX overhaul Task 6: computeTeamLift (lib/benchmark/certified/
 * team-lift.ts) was extracted from lib/benchmark/scoring/aggregate.ts's
 * applyTeamLift so TeamIQ and WorkBench share ONE lift implementation. These
 * checks pin the formula against silent change and prove the WorkBench feed
 * (metrics.ts's second buildTeamIqComboMatrixRows call, track: "workbench")
 * produces real numbers end to end.
 */
import {
  computeComparableTrackTeamLift,
  computeTeamLift,
  sortRowsByTeamLift,
  type ComparableTrackRowLike,
  type TeamLiftRowLike,
} from "../lib/benchmark/certified/team-lift";
import { formatLift } from "../components/benchmark/teamiq/ComboMatrix";
import {
  buildTeamIqComboMatrixRows,
  deriveSoloTeamComposition,
  deriveTeamComposition,
  type TeamIqComboMatrixRow,
} from "../lib/benchmark/teamiq";
import { aggregateCertifiedRunScores } from "../lib/benchmark/scoring/aggregate";
import type {
  BenchmarkAttemptV2,
  BenchmarkTeamCompositionRole,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function comparableRow({
  modelVariantKeys = ["model-a\u0000medium"],
  tracks,
  attemptsByTrack = {},
}: {
  modelVariantKeys?: string[];
  tracks: Record<string, number>;
  attemptsByTrack?: Record<string, number>;
}): ComparableTrackRowLike {
  return {
    modelIds: modelVariantKeys.map((key) => key.split("\u0000")[0]),
    modelVariantKeys,
    jobSuccessScore: 0,
    trackBreakdown: Object.entries(tracks).map(
      ([track, averageVerifiedQuality]) => ({
        track,
        averageVerifiedQuality,
        attempts: attemptsByTrack[track] ?? 1,
      })
    ),
  };
}

const comparableTeam = comparableRow({
  modelVariantKeys: ["model-a\u0000medium", "model-b\u0000medium"],
  tracks: { teamiq: 0.8, workbench: 1 },
});
const comparableSolos = new Map([
  [
    "model-a\u0000medium",
    comparableRow({ tracks: { teamiq: 0.7 } }),
  ],
  [
    "model-b\u0000medium",
    comparableRow({
      modelVariantKeys: ["model-b\u0000medium"],
      tracks: { teamiq: 0.6 },
    }),
  ],
]);
const comparableLift = computeComparableTrackTeamLift(
  comparableTeam,
  comparableSolos
);
check(
  "comparable lift uses only tracks shared by every team member",
  comparableLift?.teamLift === 10 &&
    comparableLift.bestSoloScore === 70 &&
    comparableLift.tracks.join(",") === "teamiq",
  comparableLift
);

check(
  "comparable lift is null when team and solo evidence have no overlapping track",
  computeComparableTrackTeamLift(
    comparableTeam,
    new Map([
      [
        "model-a\u0000medium",
        comparableRow({ tracks: { gameiq: 0.9 } }),
      ],
      [
        "model-b\u0000medium",
        comparableRow({
          modelVariantKeys: ["model-b\u0000medium"],
          tracks: { gameiq: 0.8 },
        }),
      ],
    ])
  ) === null
);

const incompleteTrackLift = computeComparableTrackTeamLift(
  comparableRow({
    modelVariantKeys: ["model-a\u0000medium", "model-b\u0000medium"],
    tracks: { teamiq: 0.8, workbench: 0.9 },
  }),
  new Map([
    [
      "model-a\u0000medium",
      comparableRow({ tracks: { teamiq: 0.7, workbench: 0.4 } }),
    ],
    [
      "model-b\u0000medium",
      comparableRow({
        modelVariantKeys: ["model-b\u0000medium"],
        tracks: { teamiq: 0.6 },
      }),
    ],
  ])
);
check(
  "a track missing any member solo baseline is excluded",
  incompleteTrackLift?.tracks.join(",") === "teamiq" &&
    incompleteTrackLift.teamLift === 10,
  incompleteTrackLift
);

const equalTrackLift = computeComparableTrackTeamLift(
  comparableRow({
    modelVariantKeys: ["model-a\u0000medium", "model-b\u0000medium"],
    tracks: { teamiq: 0.8, workbench: 0.4 },
    attemptsByTrack: { teamiq: 100, workbench: 1 },
  }),
  new Map([
    [
      "model-a\u0000medium",
      comparableRow({
        tracks: { teamiq: 0.7, workbench: 0.1 },
        attemptsByTrack: { teamiq: 2, workbench: 90 },
      }),
    ],
    [
      "model-b\u0000medium",
      comparableRow({
        modelVariantKeys: ["model-b\u0000medium"],
        tracks: { teamiq: 0.6, workbench: 0.2 },
        attemptsByTrack: { teamiq: 50, workbench: 3 },
      }),
    ],
  ])
);
check(
  "common tracks average track-local point differences equally, not by attempts",
  equalTrackLift?.tracks.join(",") === "teamiq,workbench" &&
    equalTrackLift.bestSoloScore === 45 &&
    equalTrackLift.teamLift === 15,
  equalTrackLift
);

const matchingVariantLift = computeComparableTrackTeamLift(
  comparableRow({
    modelVariantKeys: ["model-a\u0000medium"],
    tracks: { teamiq: 0.8 },
  }),
  new Map([
    [
      "model-a\u0000medium",
      comparableRow({ tracks: { teamiq: 0.6 } }),
    ],
    [
      "model-a\u0000high",
      comparableRow({
        modelVariantKeys: ["model-a\u0000high"],
        tracks: { teamiq: 0.95 },
      }),
    ],
  ])
);
check(
  "comparable lift ignores solo rows for non-member variant keys",
  matchingVariantLift?.bestSoloScore === 60 &&
    matchingVariantLift.teamLift === 20,
  matchingVariantLift
);

// --- (a) TeamIQ lift equals a hand-computed fixture value -----------------
//
// Same numbers as scripts/test-teamiq-combos.mts's "strongRow" fixture
// (teamScore 84, solo GPT 74, solo Gemini 60, team cost $1 vs best-solo cost
// $0.80) so this pins computeTeamLift against the value that fixture already
// asserts production TeamIQ produces (teamLift === 10). Hand computation:
//   bestSoloScore = max(74, 60) = 74
//   teamLift      = round(84) - round(74) = 10
//   costRatio     = 1 / 0.8 = 1.25 (not > 3, so not "overpriced")
//   teamLift >= 10 && !overpriced && costAdjustedTeamLift > 0 -> "strong_positive"
const teamIqTeamRow: TeamLiftRowLike = {
  modelIds: ["openai:gpt-test", "google:gemini-test"],
  jobSuccessScore: 84,
  averageCostUsd: 1,
  durationMs: 50_000,
};
const teamIqSoloByModel = new Map<string, TeamLiftRowLike>([
  [
    "openai:gpt-test",
    { modelIds: ["openai:gpt-test"], jobSuccessScore: 74, averageCostUsd: 0.8, durationMs: 60_000 },
  ],
  [
    "google:gemini-test",
    { modelIds: ["google:gemini-test"], jobSuccessScore: 60, averageCostUsd: 0.4, durationMs: 40_000 },
  ],
]);
const teamIqLift = computeTeamLift(teamIqTeamRow, teamIqSoloByModel);

check(
  "TeamIQ lift matches the hand-computed fixture value (10, strong_positive)",
  teamIqLift?.bestSoloScore === 74 &&
    teamIqLift?.teamLift === 10 &&
    teamIqLift?.label === "strong_positive",
  teamIqLift
);

// The same fixture run through the real cross-track leaderboard aggregation
// (lib/benchmark/scoring/aggregate.ts's applyTeamLift, now delegating to
// computeTeamLift) must land on the identical number — proof the extraction
// changed nothing observable.
const createdAt = "2026-07-17T00:00:00.000Z";
const gptRole: BenchmarkTeamCompositionRole = {
  role: "architect",
  slot: "architect",
  modelId: "openai:gpt-test",
  providerId: "openai",
  displayName: "GPT Test",
  temperature: 0,
};
const geminiRole: BenchmarkTeamCompositionRole = {
  role: "worker",
  slot: "worker",
  modelId: "google:gemini-test",
  providerId: "google",
  displayName: "Gemini Test",
  temperature: 0,
};
const soloGpt = deriveSoloTeamComposition({ modelId: "openai:gpt-test", displayName: "GPT Test" });
const soloGemini = deriveSoloTeamComposition({ modelId: "google:gemini-test", displayName: "Gemini Test" });
const strongTeam = deriveTeamComposition({ name: "GPT plus Gemini", roles: [gptRole, geminiRole] });

function teamIqAttempt(
  id: string,
  teamCompositionId: string,
  jobSuccessScore: number,
  costUsd: number,
  durationMs: number
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId: "case-1",
    teamCompositionId,
    mode: "certified",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: createdAt,
    completedAt: createdAt,
    verifiedQuality: jobSuccessScore / 100,
    jobSuccessScore,
    efficiencyScore: jobSuccessScore,
    costUsd,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "test-harness",
    promptSetVersion: "test-prompts",
    scoringVersion: "test-scoring",
  };
}

const leaderboard = aggregateCertifiedRunScores({
  attempts: [
    teamIqAttempt("solo-gpt", soloGpt.id, 74, 0.8, 60_000),
    teamIqAttempt("solo-gemini", soloGemini.id, 60, 0.4, 40_000),
    teamIqAttempt("strong-team", strongTeam.id, 84, 1, 50_000),
  ],
  teamCompositions: [soloGpt, soloGemini, strongTeam],
});
const leaderboardTeamRow = leaderboard.find((row) => row.teamCompositionId === strongTeam.id);
check(
  "the refactored applyTeamLift (leaderboard aggregation) reproduces the same lift",
  leaderboardTeamRow?.teamLift === 10 && leaderboardTeamRow?.bestSoloScore === 74,
  leaderboardTeamRow
);

const disjointLeaderboard = aggregateCertifiedRunScores({
  attempts: [
    {
      ...teamIqAttempt("disjoint-a-gameiq", soloGpt.id, 70, 0.8, 60_000),
      caseId: "gameiq-a",
      track: "gameiq",
    },
    {
      ...teamIqAttempt(
        "disjoint-b-reliability",
        soloGemini.id,
        60,
        0.4,
        40_000
      ),
      caseId: "reliability-b",
      track: "toolreliability",
    },
    {
      ...teamIqAttempt("disjoint-team-teamiq", strongTeam.id, 80, 1, 50_000),
      caseId: "teamiq-team",
    },
    {
      ...teamIqAttempt(
        "disjoint-team-workbench",
        strongTeam.id,
        100,
        1,
        50_000
      ),
      caseId: "workbench-team",
      track: "workbench",
    },
  ],
  teamCompositions: [soloGpt, soloGemini, strongTeam],
});
const disjointLeaderboardTeam = disjointLeaderboard.find(
  (row) => row.teamCompositionId === strongTeam.id
);
check(
  "aggregate lift is null when solos and team have disjoint tracks",
  disjointLeaderboardTeam?.teamLift === null &&
    disjointLeaderboardTeam.teamLiftTracks.length === 0,
  disjointLeaderboardTeam
);

// --- (b) WorkBench team+solo pair produces the expected lift --------------
//
// bestSoloScore = max(70, 55) = 70; teamLift = round(90) - round(70) = 20.
const workBenchTeamRow: TeamLiftRowLike = {
  modelIds: ["openai:gpt-wb", "anthropic:claude-wb"],
  jobSuccessScore: 90,
  averageCostUsd: 1.5,
  durationMs: 120_000,
};
const workBenchSoloByModel = new Map<string, TeamLiftRowLike>([
  [
    "openai:gpt-wb",
    { modelIds: ["openai:gpt-wb"], jobSuccessScore: 70, averageCostUsd: 1, durationMs: 100_000 },
  ],
  [
    "anthropic:claude-wb",
    { modelIds: ["anthropic:claude-wb"], jobSuccessScore: 55, averageCostUsd: 0.9, durationMs: 90_000 },
  ],
]);
const workBenchLift = computeTeamLift(workBenchTeamRow, workBenchSoloByModel);
check(
  "WorkBench team+solo pair produces the expected lift (20)",
  workBenchLift?.bestSoloScore === 70 && workBenchLift?.teamLift === 20,
  workBenchLift
);

// End-to-end: the SAME buildTeamIqComboMatrixRows the dashboard assembly
// (lib/benchmark/metrics.ts) now calls a second time with track: "workbench"
// must produce a real workbench-track combo row with a populated teamLift,
// proving the metrics.ts wiring (not just the row-level formula) works.
const soloGptWb = deriveSoloTeamComposition({ modelId: "openai:gpt-wb", displayName: "GPT WB" });
const soloClaudeWb = deriveSoloTeamComposition({ modelId: "anthropic:claude-wb", displayName: "Claude WB" });
const workBenchTeam = deriveTeamComposition({
  name: "GPT plus Claude (WorkBench)",
  roles: [
    { ...gptRole, modelId: "openai:gpt-wb", displayName: "GPT WB", slot: "architect-wb" },
    {
      role: "worker",
      slot: "worker-wb",
      modelId: "anthropic:claude-wb",
      providerId: "anthropic",
      displayName: "Claude WB",
      temperature: 0,
    },
  ],
});

function workBenchAttempt(
  id: string,
  teamCompositionId: string,
  jobSuccessScore: number,
  costUsd: number,
  durationMs: number
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId: "workbench-case-1",
    teamCompositionId,
    mode: "certified",
    track: "workbench",
    harnessProfile: "local-runner",
    status: "passed",
    startedAt: createdAt,
    completedAt: createdAt,
    verifiedQuality: jobSuccessScore / 100,
    jobSuccessScore,
    efficiencyScore: jobSuccessScore,
    costUsd,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "test-harness",
    promptSetVersion: "test-prompts",
    scoringVersion: "test-scoring",
  };
}

const workBenchComboRows = buildTeamIqComboMatrixRows({
  attempts: [
    workBenchAttempt("solo-gpt-wb", soloGptWb.id, 70, 1, 100_000),
    workBenchAttempt("solo-claude-wb", soloClaudeWb.id, 55, 0.9, 90_000),
    workBenchAttempt("workbench-team", workBenchTeam.id, 90, 1.5, 120_000),
  ],
  teamCompositions: [soloGptWb, soloClaudeWb, workBenchTeam],
  track: "workbench",
});
const workBenchComboRow = workBenchComboRows.find(
  (row) => row.teamCompositionId === workBenchTeam.id
);
check(
  "buildTeamIqComboMatrixRows(track: workbench) yields a real combo row with lift",
  workBenchComboRow?.track === "workbench" &&
    workBenchComboRow?.teamLift === 20 &&
    workBenchComboRow?.bestSoloScore === 70,
  workBenchComboRow
);

// --- (c) missing baseline -> null + dash rendering contract ---------------
const partialSoloByModel = new Map<string, TeamLiftRowLike>([
  [
    "openai:gpt-wb",
    { modelIds: ["openai:gpt-wb"], jobSuccessScore: 70, averageCostUsd: 1, durationMs: 100_000 },
  ],
  // "anthropic:claude-wb" has no solo baseline entry.
]);
const missingBaselineLift = computeTeamLift(workBenchTeamRow, partialSoloByModel);
check(
  "a team with an incomplete solo baseline gets null lift, never a partial number",
  missingBaselineLift === null,
  missingBaselineLift
);

const effortTeamRow: TeamLiftRowLike = {
  modelIds: ["openai:gpt-effort"],
  modelVariantKeys: ["openai:gpt-effort\u0000high"],
  jobSuccessScore: 80,
};
const effortSoloRows = new Map<string, TeamLiftRowLike>([
  [
    "openai:gpt-effort\u0000low",
    {
      modelIds: ["openai:gpt-effort"],
      modelVariantKeys: ["openai:gpt-effort\u0000low"],
      jobSuccessScore: 90,
    },
  ],
  [
    "openai:gpt-effort\u0000high",
    {
      modelIds: ["openai:gpt-effort"],
      modelVariantKeys: ["openai:gpt-effort\u0000high"],
      jobSuccessScore: 60,
    },
  ],
]);
const matchingEffortLift = computeTeamLift(effortTeamRow, effortSoloRows);
check(
  "team lift uses only the solo baseline with the same effort",
  matchingEffortLift?.bestSoloScore === 60 && matchingEffortLift.teamLift === 20,
  matchingEffortLift
);
effortSoloRows.delete("openai:gpt-effort\u0000high");
check(
  "team lift is null when the matching effort baseline is missing",
  computeTeamLift(effortTeamRow, effortSoloRows) === null
);

const legacyDefaultTeam: TeamLiftRowLike = {
  modelIds: ["openai:gpt-effort"],
  jobSuccessScore: 80,
};
const explicitHighUnderLegacyKey = new Map<string, TeamLiftRowLike>([
  [
    "openai:gpt-effort",
    {
      modelIds: ["openai:gpt-effort"],
      modelVariantKeys: ["openai:gpt-effort\u0000high"],
      jobSuccessScore: 60,
    },
  ],
]);
check(
  "legacy Default team does not match an explicit High solo row",
  computeTeamLift(legacyDefaultTeam, explicitHighUnderLegacyKey) === null
);
const explicitDefaultUnderLegacyKey = new Map<string, TeamLiftRowLike>([
  [
    "openai:gpt-effort",
    {
      modelIds: ["openai:gpt-effort"],
      modelVariantKeys: ["openai:gpt-effort\u0000default"],
      jobSuccessScore: 60,
    },
  ],
]);
check(
  "legacy Default team accepts an explicitly identified Default solo row",
  computeTeamLift(legacyDefaultTeam, explicitDefaultUnderLegacyKey)?.teamLift ===
    20
);
const legacySoloUnderLegacyKey = new Map<string, TeamLiftRowLike>([
  [
    "openai:gpt-effort",
    {
      modelIds: ["openai:gpt-effort"],
      jobSuccessScore: 60,
    },
  ],
]);
check(
  "legacy Default team remains compatible with a legacy solo row",
  computeTeamLift(legacyDefaultTeam, legacySoloUnderLegacyKey)?.teamLift === 20
);
const legacySoloUnderHighKey = new Map<string, TeamLiftRowLike>([
  [
    "openai:gpt-effort\u0000high",
    {
      modelIds: ["openai:gpt-effort"],
      jobSuccessScore: 60,
    },
  ],
]);
check(
  "explicit High team does not reinterpret a legacy solo as High",
  computeTeamLift(effortTeamRow, legacySoloUnderHighKey) === null
);

const lowEffortSolo = deriveSoloTeamComposition({
  modelId: "openai:gpt-effort",
  displayName: "GPT Effort",
  reasoningEffort: "low",
});
const highEffortSolo = deriveSoloTeamComposition({
  modelId: "openai:gpt-effort",
  displayName: "GPT Effort",
  reasoningEffort: "high",
});
const highEffortTeam = deriveTeamComposition({
  name: "High effort pair",
  strategy: "parallel",
  roles: [
    {
      ...highEffortSolo.roles[0],
      role: "architect",
      slot: "architect",
    },
    {
      ...highEffortSolo.roles[0],
      role: "worker",
      slot: "worker",
    },
  ],
});
const effortAttempts = [
  teamIqAttempt("effort-low", lowEffortSolo.id, 90, 1, 1_000),
  teamIqAttempt("effort-high", highEffortSolo.id, 60, 1, 1_000),
  teamIqAttempt("effort-team", highEffortTeam.id, 80, 1, 1_000),
];
const effortComboRows = buildTeamIqComboMatrixRows({
  attempts: effortAttempts,
  teamCompositions: [lowEffortSolo, highEffortSolo, highEffortTeam],
  track: "teamiq",
});
check(
  "per-attempt team lift links roles to same-effort solo evidence",
  effortComboRows[0]?.teamLift === 20,
  effortComboRows
);
const missingEffortComboRows = buildTeamIqComboMatrixRows({
  attempts: [effortAttempts[0], effortAttempts[2]],
  teamCompositions: [lowEffortSolo, highEffortTeam],
  track: "teamiq",
});
check(
  "per-attempt team lift does not fall back to another effort",
  missingEffortComboRows[0]?.teamLift === null,
  missingEffortComboRows
);
check(
  "null lift renders as a dash (never n/a, never 0, never blank)",
  formatLift(null) === "–",
  formatLift(null)
);
check(
  "a real lift still renders with a sign",
  formatLift(20) === "+20",
  formatLift(20)
);

// --- (d) mixed-track rows sort correctly by lift ---------------------------
function comboRow(overrides: Partial<TeamIqComboMatrixRow>): TeamIqComboMatrixRow {
  return {
    id: overrides.id ?? "row",
    teamCompositionId: overrides.teamCompositionId ?? overrides.id ?? "row",
    teamName: overrides.teamName ?? "Row",
    comboHash: overrides.comboHash ?? "hash",
    track: overrides.track ?? "teamiq",
    modelIds: overrides.modelIds ?? ["model-a", "model-b"],
    modelVariantKeys:
      overrides.modelVariantKeys ??
      ["model-a\u0000default", "model-b\u0000default"],
    isSolo: false,
    attempts: overrides.attempts ?? 3,
    verifiedQuality: overrides.verifiedQuality ?? 0.5,
    jobSuccessScore: overrides.jobSuccessScore ?? 50,
    costUsd: null,
    averageCostUsd: null,
    durationMs: null,
    averageDurationMs: null,
    bestSoloScore: null,
    teamLift: overrides.teamLift ?? null,
    teamLiftLabel: null,
    isParetoRecommended: false,
    recommendationLabel: "insufficient_data",
    ...overrides,
  };
}

const mixedRows: TeamIqComboMatrixRow[] = [
  comboRow({ id: "workbench-low", track: "workbench", teamName: "WorkBench low", teamLift: 5, verifiedQuality: 0.7 }),
  comboRow({ id: "teamiq-high", track: "teamiq", teamName: "TeamIQ high", teamLift: 20, verifiedQuality: 0.8 }),
  comboRow({ id: "workbench-no-baseline", track: "workbench", teamName: "WorkBench no baseline", teamLift: null, verifiedQuality: 0.9 }),
  comboRow({ id: "teamiq-mid", track: "teamiq", teamName: "TeamIQ mid", teamLift: 12, verifiedQuality: 0.6 }),
];
const sortedMixed = sortRowsByTeamLift(mixedRows);
check(
  "mixed-track rows sort by lift descending, nulls last",
  sortedMixed.map((row) => row.id).join(",") ===
    "teamiq-high,teamiq-mid,workbench-low,workbench-no-baseline",
  sortedMixed.map((row) => ({ id: row.id, track: row.track, teamLift: row.teamLift }))
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

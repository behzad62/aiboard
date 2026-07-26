/* Decision dashboard selector checks (run: npx tsx scripts/test-benchmark-decision-dashboard.mts) */
import {
  buildDecisionVerdicts,
  filterDecisionRows,
  sortDecisionRows,
  wilsonInterval,
  type DecisionFilters,
  type DecisionRow,
} from "../lib/benchmark/certified/decision-dashboard";
import { readLeaderboard } from "../lib/benchmark/certified/dashboard-selectors";
import { withCertifiedDeleteMetadata } from "../components/benchmark/useBenchmarkDashboard";
import { readDecisionDashboardRows } from "../components/benchmark/results/BenchmarkDecisionDashboard";
import { buildCertifiedBenchmarkDashboardData } from "../lib/benchmark/metrics";
import type {
  BenchmarkFailure,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function near(actual: number, expected: number, tolerance = 0.0001): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function row(
  id: string,
  overrides: Partial<DecisionRow> = {}
): DecisionRow {
  return {
    id,
    label: id,
    tracks: ["workbench"],
    caseTitles: ["Parser repair"],
    attempts: 10,
    passed: 8,
    preliminary: false,
    verifiedQuality: 0.8,
    overallScore: 0.8,
    trackBreakdown: [
      {
        track: "workbench",
        attempts: 10,
        passed: 8,
        verifiedPassRate: 0.8,
        averageVerifiedQuality: 0.8,
      },
    ],
    passRate: 0.8,
    efficiencyScore: 80,
    toolReliabilityScore: 90,
    toolReliabilitySamples: 10,
    averageCostUsd: null,
    costPerPass: null,
    averageDurationMs: 10_000,
    durationMs: 10_000,
    speedPerPassMs: 12_500,
    totalTokens: 100_000,
    tokensPerPass: 12_500,
    costBasis: "tokens",
    teamLift: null,
    teamLiftTracks: [],
    teamCompositionId: id,
    modelIds: [id],
    isTeam: false,
    latestAttemptsByTrack: {},
    providerUnavailableAttemptIds: [],
    providerUnavailableAttemptIdsByTrack: {},
    providerIds: [],
    reasoningEfforts: [],
    reasoningEffortDetails: [],
    failureDetails: [],
    ...overrides,
  };
}

const interval = wilsonInterval(5, 10);
check(
  "Wilson interval matches the 95% interval for five of ten passes",
  interval !== null && near(interval.lower, 0.2366) && near(interval.upper, 0.7634),
  interval
);
check("Wilson interval preserves no-evidence as null", wilsonInterval(0, 0) === null);

const rows: DecisionRow[] = [
  row("sol-low", {
    label: "GPT-5.6 Sol · Low",
    providerIds: ["chatgpt"],
    reasoningEfforts: ["low"],
  }),
  row("sol", {
    label: "GPT-5.6 Sol · Extra high",
    providerIds: ["chatgpt"],
    reasoningEfforts: ["xhigh"],
  }),
  row("mini", {
    label: "GPT-5.4 Mini",
    tracks: ["gameiq"],
    trackBreakdown: [
      {
        track: "gameiq",
        attempts: 2,
        passed: 1,
        verifiedPassRate: 0.5,
        averageVerifiedQuality: 0.6,
      },
    ],
    caseTitles: ["Chess tactics"],
    attempts: 2,
    preliminary: true,
    providerIds: ["chatgpt"],
    reasoningEfforts: ["high"],
  }),
  row("team", {
    label: "Sol + Mini",
    modelIds: ["sol", "mini"],
    isTeam: true,
    providerIds: ["chatgpt", "copilot"],
    reasoningEfforts: ["xhigh", "high"],
    teamLift: 14,
  }),
];

check(
  "unfiltered results preserve separate effort variants for one model",
  filterDecisionRows(rows, {
    query: "",
    track: "all",
    kind: "solo",
    provider: "all",
    effort: "all",
    evidence: "all",
  })
    .filter((item) => item.id.startsWith("sol"))
    .map((item) => item.id)
    .join(",") === "sol-low,sol",
  rows
);

const allFilters: DecisionFilters = {
  query: "",
  track: "all",
  kind: "all",
  provider: "all",
  effort: "all",
  evidence: "all",
};

check(
  "text filter searches model and case titles",
  filterDecisionRows(rows, { ...allFilters, query: "chess" }).map((item) => item.id).join(",") === "mini"
);
check(
  "track and evidence filters compose",
  filterDecisionRows(rows, {
    ...allFilters,
    track: "gameiq",
    evidence: "preliminary",
  }).map((item) => item.id).join(",") === "mini"
);
check(
  "provider and team filters compose",
  filterDecisionRows(rows, {
    ...allFilters,
    provider: "copilot",
    kind: "team",
  }).map((item) => item.id).join(",") === "team"
);
check(
  "reasoning effort filter uses optional metadata",
  filterDecisionRows(rows, { ...allFilters, effort: "high", kind: "solo" }).map((item) => item.id).join(",") === "mini"
);

const legacyTeam = {
  id: "legacy-default",
  name: "Legacy Default",
  comboHash: "legacy-default",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:legacy",
      providerId: "openai",
      displayName: "Legacy",
      temperature: 0,
    },
  ],
} as BenchmarkTeamComposition;
const legacyMetadata = withCertifiedDeleteMetadata(
  { leaderboard: [row("legacy-default")] } as never,
  [],
  [legacyTeam]
).leaderboard[0];
check(
  "legacy dashboard metadata exposes Default reasoning",
  legacyMetadata?.reasoningEfforts?.join(",") === "default",
  legacyMetadata
);

const explicitDefaultTeam = {
  ...legacyTeam,
  id: "explicit-default",
  comboHash: "explicit-default",
  roles: [{ ...legacyTeam.roles[0], reasoningEffort: "default" as const }],
} as BenchmarkTeamComposition;
const compatibleMetadata = withCertifiedDeleteMetadata(
  buildCertifiedBenchmarkDashboardData({
    caseV2: [],
    attemptsV2: [
      {
        id: "attempt-legacy",
        runId: "run-compatible",
        caseId: "same-default-decision",
        mode: "certified",
        teamCompositionId: "legacy-default",
        track: "teamiq",
        status: "passed",
        startedAt: "2026-07-26T00:00:00.000Z",
      },
      {
        id: "attempt-explicit",
        runId: "run-compatible",
        caseId: "same-default-decision",
        mode: "certified",
        teamCompositionId: "explicit-default",
        track: "gameiq",
        status: "passed",
        startedAt: "2026-07-26T00:01:00.000Z",
      },
    ] as never,
    verifierResults: [],
    teamCompositions: [legacyTeam, explicitDefaultTeam],
    harnessCertifications: [],
  }),
  [
    {
      id: "attempt-legacy",
      runId: "run-compatible",
      caseId: "same-default-decision",
      mode: "certified",
      teamCompositionId: "legacy-default",
      track: "teamiq",
      status: "passed",
      startedAt: "2026-07-26T00:00:00.000Z",
    },
    {
      id: "attempt-explicit",
      runId: "run-compatible",
      caseId: "same-default-decision",
      mode: "certified",
      teamCompositionId: "explicit-default",
      track: "gameiq",
      status: "passed",
      startedAt: "2026-07-26T00:01:00.000Z",
    },
  ] as never,
  [legacyTeam, explicitDefaultTeam]
).leaderboard[0];
check(
  "canonical default rows retain delete metadata across persisted composition aliases",
  compatibleMetadata?.latestAttemptId === "attempt-explicit" &&
    compatibleMetadata.attempts === 1 &&
    compatibleMetadata.teamCompositionIds?.slice().sort().join(",") ===
      "explicit-default,legacy-default" &&
    Object.keys(compatibleMetadata.latestAttemptsByTrack ?? {})
      .sort()
      .join(",") === "gameiq,teamiq",
  compatibleMetadata
);

const failedBudgetAttempt = {
  id: "attempt-failed-budget",
  runId: "run-failed-budget",
  caseId: "case-failed-budget",
  mode: "certified",
  teamCompositionId: "legacy-default",
  track: "workbench",
  status: "failed_budget",
  startedAt: "2026-07-26T00:02:00.000Z",
  failureIds: ["failure-failed-budget"],
} as never;
const failedBudgetFailure: BenchmarkFailure = {
  id: "failure-failed-budget",
  runId: "run-failed-budget",
  caseId: "case-failed-budget",
  domain: "build",
  source: "benchmark",
  code: "budget_exhausted",
  severity: "error",
  message: "Wall-clock budget exceeded (900000ms >= 900000ms).",
  createdAt: "2026-07-26T00:17:00.000Z",
};
const withFailureInput = {
  leaderboard: [
    {
      ...row("legacy-default"),
      teamCompositionId: "legacy-default",
      tracks: ["workbench", "gameiq"],
    },
  ],
  overallLeaderboard: [
    {
      ...row("legacy-default"),
      teamCompositionId: "legacy-default",
      tracks: ["workbench", "gameiq"],
    },
  ],
};
const failureMetadata = withCertifiedDeleteMetadata(
  withFailureInput as never,
  [failedBudgetAttempt],
  [legacyTeam],
  [failedBudgetFailure, { ...failedBudgetFailure }]
);
const failureRow = readLeaderboard(failureMetadata, "all", "overall")[0];
check(
  "certified leaderboard rows expose linked failure provenance across alternate sorts",
  failureRow?.failureDetails?.length === 1 &&
    failureRow.failureDetails[0]?.message ===
      "Wall-clock budget exceeded (900000ms >= 900000ms)." &&
    failureRow.failureDetails[0]?.code === "budget_exhausted" &&
    failureRow.failureDetails[0]?.status === "failed_budget" &&
    failureRow.failureDetails[0]?.attemptId === "attempt-failed-budget" &&
    failureRow.failureDetails[0]?.track === "workbench",
  failureRow
);
check(
  "track scoping keeps only failure provenance from the selected track",
  readLeaderboard(failureMetadata, "gameiq", "overall")[0]?.failureDetails
    ?.length === 0,
  readLeaderboard(failureMetadata, "gameiq", "overall")[0]
);
check(
  "legacy leaderboard rows default failure provenance to empty",
  readLeaderboard({ leaderboard: [row("legacy")] }, "all")[0]?.failureDetails
    ?.length === 0,
  readLeaderboard({ leaderboard: [row("legacy")] }, "all")[0]
);

const mixedFailureMetadata = withCertifiedDeleteMetadata(
  withFailureInput as never,
  [
    {
      ...failedBudgetAttempt,
      id: "mixed-workbench-scored-failure",
      status: "failed_budget",
      startedAt: "2026-07-26T00:01:00.000Z",
      failureIds: [],
    },
    {
      ...failedBudgetAttempt,
      id: "mixed-workbench-excluded-unlinked",
      status: "provider_unavailable",
      startedAt: "2026-07-26T00:00:00.000Z",
      failureIds: [],
    },
    {
      ...failedBudgetAttempt,
      id: "mixed-workbench-newer-pass",
      status: "passed",
      startedAt: "2026-07-26T00:03:00.000Z",
      failureIds: [],
    },
    {
      ...failedBudgetAttempt,
      id: "mixed-gameiq-failure",
      track: "gameiq",
      status: "failed_model",
      startedAt: "2026-07-26T00:02:00.000Z",
      failureIds: [],
    },
  ] as never,
  [legacyTeam],
  []
);
const mixedAllRow = readLeaderboard(
  mixedFailureMetadata,
  "all",
  "overall"
)[0] as DecisionRow & {
  failedAttemptCount?: number | null;
  failedAttemptCountByTrack?: Record<string, number>;
};
const mixedWorkBenchRow = readLeaderboard(
  mixedFailureMetadata,
  "workbench",
  "overall"
)[0] as DecisionRow & { failedAttemptCount?: number | null };
const mixedGameIqRow = readLeaderboard(
  mixedFailureMetadata,
  "gameiq",
  "overall"
)[0] as DecisionRow & { failedAttemptCount?: number | null };
check(
  "persisted attempt statuses expose exact failures including older excluded unlinked history",
  mixedAllRow?.failedAttemptCount === 3 &&
    mixedAllRow.failedAttemptCountByTrack?.workbench === 2 &&
    mixedAllRow.failedAttemptCountByTrack?.gameiq === 1 &&
    mixedWorkBenchRow?.failedAttemptCount === 2 &&
    mixedGameIqRow?.failedAttemptCount === 1,
  { mixedAllRow, mixedWorkBenchRow, mixedGameIqRow }
);

const disjointSoloA = {
  ...legacyTeam,
  id: "disjoint-solo-a",
  name: "Disjoint Solo A",
  comboHash: "disjoint-solo-a",
  roles: [{ ...legacyTeam.roles[0], modelId: "model-a", displayName: "Model A" }],
} as BenchmarkTeamComposition;
const disjointSoloB = {
  ...legacyTeam,
  id: "disjoint-solo-b",
  name: "Disjoint Solo B",
  comboHash: "disjoint-solo-b",
  roles: [{ ...legacyTeam.roles[0], modelId: "model-b", displayName: "Model B" }],
} as BenchmarkTeamComposition;
const disjointTeamComposition = {
  id: "disjoint-team",
  name: "Disjoint Team",
  comboHash: "disjoint-team",
  roles: [
    {
      ...disjointSoloA.roles[0],
      role: "architect",
      slot: "architect",
    },
    {
      ...disjointSoloB.roles[0],
      role: "worker",
      slot: "worker",
    },
  ],
} as BenchmarkTeamComposition;
const disjointAttempts = [
  {
    id: "disjoint-a-gameiq",
    runId: "run-disjoint",
    caseId: "gameiq-a",
    mode: "certified",
    teamCompositionId: disjointSoloA.id,
    track: "gameiq",
    status: "passed",
    startedAt: "2026-07-26T00:00:00.000Z",
    verifiedQuality: 0.7,
    jobSuccessScore: 70,
  },
  {
    id: "disjoint-b-reliability",
    runId: "run-disjoint",
    caseId: "reliability-b",
    mode: "certified",
    teamCompositionId: disjointSoloB.id,
    track: "toolreliability",
    status: "passed",
    startedAt: "2026-07-26T00:01:00.000Z",
    verifiedQuality: 0.6,
    jobSuccessScore: 60,
  },
  {
    id: "disjoint-team-teamiq",
    runId: "run-disjoint",
    caseId: "teamiq-team",
    mode: "certified",
    teamCompositionId: disjointTeamComposition.id,
    track: "teamiq",
    status: "passed",
    startedAt: "2026-07-26T00:02:00.000Z",
    verifiedQuality: 0.8,
    jobSuccessScore: 80,
  },
  {
    id: "disjoint-team-workbench",
    runId: "run-disjoint",
    caseId: "workbench-team",
    mode: "certified",
    teamCompositionId: disjointTeamComposition.id,
    track: "workbench",
    status: "passed",
    startedAt: "2026-07-26T00:03:00.000Z",
    verifiedQuality: 1,
    jobSuccessScore: 100,
  },
] as never;
const disjointDashboard = buildCertifiedBenchmarkDashboardData({
  caseV2: [],
  attemptsV2: disjointAttempts,
  verifierResults: [],
  teamCompositions: [
    disjointSoloA,
    disjointSoloB,
    disjointTeamComposition,
  ],
  harnessCertifications: [],
});
const disjointTeam = disjointDashboard.leaderboard.find(
  (item) => item.teamCompositionId === disjointTeamComposition.id
);
check(
  "disjoint solo and team tracks are not comparable",
  disjointTeam?.teamLift == null &&
    disjointTeam.teamLiftTracks.length === 0,
  disjointTeam
);

const selectorLiftRow = {
  ...row("selector-lift", {
    tracks: ["teamiq", "workbench"],
    modelIds: ["model-a", "model-b"],
    isTeam: true,
    teamLift: 10,
    teamLiftTracks: ["teamiq"],
    latestAttemptId: "workbench-failed",
    latestAttemptStatus: "failed_budget",
    latestAttemptTrack: "workbench",
    latestAttemptsByTrack: {
      teamiq: { id: "teamiq-passed", status: "passed", track: "teamiq" },
      workbench: {
        id: "workbench-failed",
        status: "failed_budget",
        track: "workbench",
      },
    },
    failureDetails: [
      {
        attemptId: "workbench-failed",
        track: "workbench",
        status: "failed_budget",
        code: "budget_exhausted",
        message: "WorkBench budget failed.",
      },
    ],
    trackBreakdown: [
      {
        track: "teamiq",
        attempts: 3,
        passed: 2,
        verifiedPassRate: 2 / 3,
        averageVerifiedQuality: 0.8,
      },
      {
        track: "workbench",
        attempts: 2,
        passed: 1,
        verifiedPassRate: 0.5,
        averageVerifiedQuality: 0.5,
      },
    ],
  }),
  teamName: "Selector Lift",
};
const selectorCertified = {
  leaderboard: [selectorLiftRow],
  teamLiftLeaderboard: [
    {
      ...selectorLiftRow,
      teamLiftTracks: undefined,
    },
  ],
};
const alternateLiftRow = readLeaderboard(
  selectorCertified,
  "all",
  "teamLift"
)[0];
check(
  "alternate leaderboard sorting reattaches lift comparison tracks",
  alternateLiftRow?.teamLiftTracks.join(",") === "teamiq",
  alternateLiftRow
);
const workbenchScopedLift = readLeaderboard(
  selectorCertified,
  "workbench",
  "teamLift"
)[0];
check(
  "track scoping clears lift when the comparison excludes that track",
  workbenchScopedLift?.teamLift === null &&
    workbenchScopedLift.teamLiftTracks.length === 0,
  workbenchScopedLift
);
const liveTeamIqRows = readDecisionDashboardRows(
  selectorCertified,
  {
    query: "",
    track: "teamiq",
    kind: "all",
    provider: "all",
    effort: "all",
    evidence: "all",
  },
  "teamLift"
);
check(
  "live Results helper retains TeamIQ-local lift and track-local metadata",
  liveTeamIqRows[0]?.teamLift === 10 &&
    liveTeamIqRows[0]?.teamLiftTracks.join(",") === "teamiq" &&
    liveTeamIqRows[0]?.latestAttemptId === "teamiq-passed" &&
    liveTeamIqRows[0]?.failureDetails.length === 0,
  liveTeamIqRows
);
const harnessRow = {
  ...row("harness-live", {
    tracks: ["harnessbench"],
    trackBreakdown: [
      {
        track: "harnessbench",
        attempts: 2,
        passed: 1,
        verifiedPassRate: 0.5,
        averageVerifiedQuality: 0.65,
      },
    ],
  }),
  teamName: "Harness live",
};
const liveHarnessRows = readDecisionDashboardRows(
  {
    leaderboard: [harnessRow],
    overallLeaderboard: [harnessRow],
  },
  {
    query: "",
    track: "harnessbench",
    kind: "all",
    provider: "all",
    effort: "all",
    evidence: "all",
  },
  "overall"
);
check(
  "live Results helper returns HarnessBench rows",
  liveHarnessRows.length === 1 &&
    liveHarnessRows[0]?.tracks.join(",") === "harnessbench" &&
    liveHarnessRows[0]?.attempts === 2,
  liveHarnessRows
);

const repeatedModelTeam = row("same-model-team", {
  label: "Sol architect + Sol worker",
  modelIds: ["sol"],
  isTeam: true,
  teamLift: 9,
});
check(
  "explicit team identity handles repeated-model multi-role teams",
  filterDecisionRows([repeatedModelTeam], {
    ...allFilters,
    kind: "team",
  })[0]?.id === repeatedModelTeam.id,
  repeatedModelTeam
);

const multiTrack = row("multi-track", {
  tracks: ["gameiq", "workbench"],
  attempts: 10,
  passed: 8,
  verifiedQuality: 0.8,
  overallScore: 0.7,
  passRate: 0.8,
  tokensPerPass: 2_000,
  speedPerPassMs: 5_000,
  trackBreakdown: [
    {
      track: "gameiq",
      attempts: 8,
      passed: 7,
      verifiedPassRate: 0.875,
      averageVerifiedQuality: 0.9,
    },
    {
      track: "workbench",
      attempts: 2,
      passed: 1,
      verifiedPassRate: 0.5,
      averageVerifiedQuality: 0.5,
    },
  ],
});
const scopedWorkbench = filterDecisionRows([multiTrack], {
  ...allFilters,
  track: "workbench",
})[0];
check(
  "track filter projects track-specific quality, pass evidence, and attempts",
  scopedWorkbench?.attempts === 2 &&
    scopedWorkbench.passed === 1 &&
    scopedWorkbench.verifiedQuality === 0.5 &&
    scopedWorkbench.overallScore === 0.5 &&
    scopedWorkbench.passRate === 0.5 &&
    scopedWorkbench.tracks.join(",") === "workbench" &&
    scopedWorkbench.tokensPerPass === null &&
    scopedWorkbench.speedPerPassMs === null,
  scopedWorkbench
);
check(
  "track-scoped rankings use projected track quality",
  sortDecisionRows(
    filterDecisionRows(
      [
        multiTrack,
        row("workbench-specialist", {
          tracks: ["workbench"],
          verifiedQuality: 0.7,
          overallScore: 0.7,
          trackBreakdown: [
            {
              track: "workbench",
              attempts: 4,
              passed: 3,
              verifiedPassRate: 0.75,
              averageVerifiedQuality: 0.7,
            },
          ],
        }),
      ],
      { ...allFilters, track: "workbench" }
    ),
    "quality"
  )
    .map((item) => item.id)
    .join(",") === "workbench-specialist,multi-track"
);

const verdictRows: DecisionRow[] = [
  row("overall", { overallScore: 0.94, verifiedQuality: 0.9 }),
  row("workbench", {
    modelIds: ["architect", "worker"],
    isTeam: true,
    overallScore: 0.9,
    verifiedQuality: 0.92,
    trackBreakdown: [
      {
        track: "workbench",
        attempts: 8,
        passed: 8,
        verifiedPassRate: 1,
        averageVerifiedQuality: 0.97,
      },
    ],
  }),
  row("workbench-solo", {
    verifiedQuality: 0.99,
    trackBreakdown: [
      {
        track: "workbench",
        attempts: 9,
        passed: 9,
        verifiedPassRate: 1,
        averageVerifiedQuality: 0.99,
      },
    ],
  }),
  row("reliable", { toolReliabilityScore: 99, toolReliabilitySamples: 7 }),
  row("lean", { tokensPerPass: 900, passed: 4 }),
  row("fast", { speedPerPassMs: 750, passed: 5 }),
  row("lift", { modelIds: ["a", "b"], isTeam: true, teamLift: 18 }),
];
const verdicts = buildDecisionVerdicts(verdictRows);
const winners = Object.fromEntries(verdicts.map((verdict) => [verdict.key, verdict.winner?.id]));
check("best overall winner uses solo overall score", winners.overall === "overall", winners);
check(
  "best WorkBench winner uses team quality and ignores a higher-scoring solo row",
  winners.workbench === "workbench",
  winners
);
check("most reliable winner uses tool reliability", winners.reliability === "reliable", winners);
check("leanest winner minimizes tokens per pass", winners.leanest === "lean", winners);
check("fastest winner minimizes time per pass", winners.fastest === "fast", winners);
check("best team lift only considers teams", winners.teamLift === "lift", winners);
const verdictByKey = Object.fromEntries(verdicts.map((verdict) => [verdict.key, verdict]));
check(
  "WorkBench verdict names teams and requests a team pack when empty",
  verdictByKey.workbench?.label === "Best WorkBench team" &&
    verdictByKey.workbench?.emptyHint ===
      "Run a team WorkBench pack to compare verified coding work.",
  verdictByKey.workbench
);
check(
  "team-lift verdict requests comparable solo and team tracks when empty",
  verdictByKey.teamLift?.emptyHint ===
    "Run the same certified track solo and as a team to measure added value.",
  verdictByKey.teamLift
);
check(
  "verdict cards expose metric-specific supporting evidence counts",
  verdictByKey.workbench?.evidenceCount === 8 &&
    verdictByKey.reliability?.evidenceCount === 7 &&
    verdictByKey.leanest?.evidenceCount === 4 &&
    verdictByKey.fastest?.evidenceCount === 5,
  verdictByKey
);

if (failures > 0) process.exit(1);
console.log("PASS");

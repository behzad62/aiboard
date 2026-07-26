/* Decision dashboard UI contract checks (run: npx tsx scripts/test-benchmark-decision-dashboard-ui.mts) */
import { existsSync, readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionLeaderboard } from "../components/benchmark/results/DecisionLeaderboard";
import { DecisionVerdicts } from "../components/benchmark/results/DecisionVerdicts";
import {
  DecisionTradeoffPointShape,
  DecisionTradeoffCharts,
  decisionTradeoffPointAriaLabel,
  decisionTradeoffPointLabel,
  projectDecisionTradeoffPoints,
} from "../components/benchmark/results/DecisionTradeoffCharts";
import { chartColorForIdentity } from "../components/benchmark/chart-utils";
import { ModelEvidenceProfile } from "../components/benchmark/results/ModelEvidenceProfile";
import {
  CertifiedLeaderboard,
  WorkBenchRoleLeaderboards,
  type RosterRole,
} from "../components/benchmark/certified/CertifiedResultTables";
import { CertifiedBenchmarkOverview } from "../components/benchmark/certified/CertifiedBenchmarkOverview";
import { ComboMatrix } from "../components/benchmark/teamiq/ComboMatrix";
import { ParetoFrontier } from "../components/benchmark/teamiq/ParetoFrontier";
import type { DecisionRow } from "../lib/benchmark/certified/decision-dashboard";
import type {
  TeamIqComboMatrixRow,
  TeamIqRecommendationCard,
} from "../lib/benchmark/teamiq";
import type { BenchmarkVariantRosterDetail } from "../lib/benchmark/model-effort";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function source(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const dashboard = source("components/benchmark/results/BenchmarkDecisionDashboard.tsx");
const verdicts = source("components/benchmark/results/DecisionVerdicts.tsx");
const ribbon = source("components/benchmark/results/BenchmarkIndexRibbon.tsx");
const filters = source("components/benchmark/results/DecisionFilters.tsx");
const leaderboard = source("components/benchmark/results/DecisionLeaderboard.tsx");
const profile = source("components/benchmark/results/ModelEvidenceProfile.tsx");
const charts = source("components/benchmark/results/DecisionTradeoffCharts.tsx");
const page = source("components/BenchmarkPage.tsx");
const decisionModel = source("lib/benchmark/certified/decision-dashboard.ts");
const packageJson = source("package.json");

const variantRow: DecisionRow = {
  id: "variant-low",
  label: "Model · Low",
  tracks: ["workbench"],
  caseTitles: [],
  attempts: 1,
  passed: 1,
  preliminary: true,
  verifiedQuality: 1,
  overallScore: 1,
  trackBreakdown: [],
  passRate: 1,
  efficiencyScore: 100,
  toolReliabilityScore: null,
  toolReliabilitySamples: null,
  averageCostUsd: null,
  costPerPass: null,
  averageDurationMs: null,
  durationMs: null,
  speedPerPassMs: null,
  totalTokens: null,
  tokensPerPass: null,
  costBasis: null,
  teamLift: null,
  teamCompositionId: "variant-low",
  modelIds: ["openai:model"],
  isTeam: false,
  latestAttemptsByTrack: {},
  providerUnavailableAttemptIds: [],
  providerUnavailableAttemptIdsByTrack: {},
  providerIds: ["openai"],
  reasoningEfforts: ["low"],
  reasoningEffortDetails: [],
  failureDetails: [],
};
const leaderboardMarkup = renderToStaticMarkup(
  React.createElement(DecisionLeaderboard, {
    rows: [
      variantRow,
      {
        ...variantRow,
        id: "variant-high",
        label: "Model · High",
        teamCompositionId: "variant-high",
        reasoningEfforts: ["high"],
      },
      {
        ...variantRow,
        id: "team",
        label: "Builder team",
        teamCompositionId: "team",
        modelIds: ["openai:architect", "openai:worker"],
        isTeam: true,
        teamLift: 12,
        reasoningEfforts: ["low", "high"],
        reasoningEffortDetails: [
          { role: "architect", displayName: "Architect", effort: "low" },
          { role: "worker", displayName: "Worker", effort: "high" },
        ],
      },
    ],
    totalRows: 3,
    sortKey: "quality",
    onSortChange: () => undefined,
    selectedId: null,
    onSelect: () => undefined,
  })
);
check(
  "leaderboard renders same-model variants and team member efforts",
  leaderboardMarkup.includes("Model · Low") &&
    leaderboardMarkup.includes("Model · High") &&
    leaderboardMarkup.includes("architect: Architect · Low") &&
    leaderboardMarkup.includes("worker: Worker · High"),
  leaderboardMarkup
);

const teamProfileMarkup = renderToStaticMarkup(
  React.createElement(ModelEvidenceProfile, {
    id: "team-profile",
    row: {
      ...variantRow,
      id: "team",
      label: "Builder team",
      modelIds: ["openai:architect", "openai:worker"],
      isTeam: true,
      reasoningEfforts: ["low", "high"],
      reasoningEffortDetails: [
        { role: "architect", displayName: "Architect", effort: "low" },
        { role: "worker", displayName: "Worker", effort: "high" },
      ],
    },
    onClose: () => undefined,
  })
);
check(
  "team profile renders effort beside each roster role",
  teamProfileMarkup.includes("architect: Architect · Low") &&
    teamProfileMarkup.includes("worker: Worker · High"),
  teamProfileMarkup
);

const teamDecisionRow: DecisionRow = {
  ...variantRow,
  id: "team-winner",
  label: "Winning team",
  teamCompositionId: "team-winner",
  modelIds: ["openai:architect", "openai:worker"],
  isTeam: true,
  teamLift: 24,
  trackBreakdown: [
    {
      track: "workbench",
      attempts: 8,
      passed: 7,
      verifiedPassRate: 0.875,
      averageVerifiedQuality: 0.9,
    },
  ],
  reasoningEfforts: ["low", "high"],
  reasoningEffortDetails: [
    { role: "architect", displayName: "Architect", effort: "low" },
    { role: "worker", displayName: "Worker", effort: "high" },
    { role: "reviewer", displayName: "Legacy", effort: "invalid" as never },
  ],
};
const verdictMarkup = renderToStaticMarkup(
  React.createElement(DecisionVerdicts, {
    rows: [variantRow, teamDecisionRow],
  })
);
check(
  "team verdict card renders each winner role effort",
  verdictMarkup.includes("architect: Architect · Low") &&
    verdictMarkup.includes("worker: Worker · High") &&
    verdictMarkup.includes("reviewer: Legacy · Default"),
  verdictMarkup
);
check(
  "WorkBench verdict renders the team winner and normalized verified quality",
  verdictMarkup.includes("Best WorkBench team") &&
    verdictMarkup.includes("Winning team") &&
    verdictMarkup.includes("90 verified quality"),
  verdictMarkup
);
const emptyTeamVerdictMarkup = renderToStaticMarkup(
  React.createElement(DecisionVerdicts, {
    rows: [variantRow],
  })
);
check(
  "empty WorkBench and team-lift cards request comparable team evidence",
  emptyTeamVerdictMarkup.includes(
    "Run a team WorkBench pack to compare verified coding work."
  ) &&
    emptyTeamVerdictMarkup.includes(
      "Run the same certified track solo and as a team to measure added value."
    ),
  emptyTeamVerdictMarkup
);

const rosterRoles: RosterRole[] = [
  { role: "architect", displayName: "Architect", reasoningEffort: "low" },
  { role: "worker", displayName: "Worker", reasoningEffort: "high" },
  { role: "reviewer", displayName: "Legacy", reasoningEffort: "default" },
];
const auditRosterMarkup = renderToStaticMarkup(
  React.createElement(CertifiedLeaderboard, {
    rows: [teamDecisionRow],
    track: "all",
    sortKey: "quality",
    onSortChange: () => undefined,
    paretoIds: new Set<string>(),
    deletingAttemptIds: new Set<string>(),
    deleteInFlight: false,
    providerErrorCount: 0,
    onDeleteAttempt: () => undefined,
    onDeleteProviderErrors: () => undefined,
    rosterByTeamId: new Map([["team-winner", rosterRoles]]),
  })
);
check(
  "audit roster chips render canonical per-role effort labels",
  auditRosterMarkup.includes("architect: Architect · Low") &&
    auditRosterMarkup.includes("worker: Worker · High") &&
    auditRosterMarkup.includes("reviewer: Legacy · Default"),
  auditRosterMarkup
);
const singleTrackRosterMarkup = renderToStaticMarkup(
  React.createElement(CertifiedLeaderboard, {
    rows: [teamDecisionRow],
    track: "teamiq",
    sortKey: "quality",
    onSortChange: () => undefined,
    paretoIds: new Set<string>(),
    deletingAttemptIds: new Set<string>(),
    deleteInFlight: false,
    providerErrorCount: 0,
    onDeleteAttempt: () => undefined,
    onDeleteProviderErrors: () => undefined,
  })
);
check(
  "single-track certified leaderboard falls back to row effort roster metadata",
  singleTrackRosterMarkup.includes("architect: Architect") &&
    singleTrackRosterMarkup.includes("worker: Worker") &&
    singleTrackRosterMarkup.includes("reviewer: Legacy") &&
    singleTrackRosterMarkup.includes("Default"),
  singleTrackRosterMarkup
);

const roleBoardsMarkup = renderToStaticMarkup(
  React.createElement(WorkBenchRoleLeaderboards, {
    boards: {
      architect: [
        {
          id: "openai:model\u0000low",
          modelId: "openai:model",
          reasoningEffort: "low",
          variantKey: "openai:model\u0000low",
          displayName: "Model · Low",
          attempts: 2,
          passed: 1,
          verifiedPassRate: 0.5,
          verifiedQuality: 0.7,
          efficiencyScore: 70,
          averageCostUsd: null,
          averageDurationMs: null,
        },
        {
          id: "openai:model\u0000high",
          modelId: "openai:model",
          reasoningEffort: "high",
          variantKey: "openai:model\u0000high",
          displayName: "Model · High",
          attempts: 2,
          passed: 2,
          verifiedPassRate: 1,
          verifiedQuality: 0.9,
          efficiencyScore: 80,
          averageCostUsd: null,
          averageDurationMs: null,
        },
      ],
      worker: [],
      reviewer: [],
    },
  })
);
check(
  "WorkBench role table renders same-model effort siblings",
  roleBoardsMarkup.includes("Model · Low") &&
    roleBoardsMarkup.includes("Model · High"),
  roleBoardsMarkup
);

const chartMarkup = renderToStaticMarkup(
  React.createElement(DecisionTradeoffCharts, {
    rows: [
      {
        ...teamDecisionRow,
        id: "same-team-low",
        label: "Same team",
        tokensPerPass: 1000,
        speedPerPassMs: 1000,
        reasoningEffortDetails: [
          { role: "architect", displayName: "Model", effort: "low" },
          { role: "worker", displayName: "Model", effort: "low" },
        ],
      },
      {
        ...teamDecisionRow,
        id: "same-team-high",
        label: "Same team",
        tokensPerPass: 2000,
        speedPerPassMs: 2000,
        reasoningEffortDetails: [
          { role: "architect", displayName: "Model", effort: "high" },
          { role: "worker", displayName: "Model", effort: "high" },
        ],
      },
    ],
  })
);
const chartRows: DecisionRow[] = [
  {
    ...variantRow,
    id: "solo-alpha",
    label: "Alpha Model · Low",
    tracks: ["gameiq"],
    attempts: 4,
    verifiedQuality: 0.61,
    overallScore: 0.84,
    tokensPerPass: 1234,
    speedPerPassMs: 2500,
  },
  {
    ...teamDecisionRow,
    id: "team-beta",
    label: "Beta Builder Team",
    tracks: ["workbench", "teamiq"],
    attempts: 8,
    verifiedQuality: 0.77,
    overallScore: null,
    tokensPerPass: 5678,
    speedPerPassMs: 9250,
  },
];
const tokenProjection = projectDecisionTradeoffPoints(chartRows, "tokens");
const timeProjection = projectDecisionTradeoffPoints(chartRows, "time");
const reorderedProjection = projectDecisionTradeoffPoints(
  [chartRows[1]!, chartRows[0]!],
  "tokens"
);
const filteredProjection = projectDecisionTradeoffPoints(
  [chartRows[1]!],
  "tokens"
);
check(
  "chart identity colors survive row reorder and filtering",
  tokenProjection[1]?.color === reorderedProjection[0]?.color &&
    tokenProjection[1]?.color === filteredProjection[0]?.color,
  { tokenProjection, reorderedProjection, filteredProjection }
);
check(
  "token and time projections share the canonical identity color",
  tokenProjection[0]?.color === timeProjection[0]?.color &&
    tokenProjection[0]?.color === chartColorForIdentity("solo-alpha"),
  { tokenProjection, timeProjection }
);
check(
  "trade-off projections prefer overall index and fall back to verified quality",
  tokenProjection[0]?.quality === 84 && tokenProjection[1]?.quality === 77,
  tokenProjection
);
const teamPointLabel = decisionTradeoffPointAriaLabel(
  tokenProjection[1]!,
  "Tokens per successful case",
  (value) => `${Math.round(value).toLocaleString()} tokens`
);
check(
  "point label carries full identity, kind, tracks, index, attempts, and X metric",
  teamPointLabel.includes("Beta Builder Team") &&
    teamPointLabel.includes("Team") &&
    teamPointLabel.includes("WorkBench") &&
    teamPointLabel.includes("TeamIQ") &&
    teamPointLabel.includes("Overall index: 77.0") &&
    teamPointLabel.includes("Tokens per successful case: 5,678 tokens") &&
    teamPointLabel.includes("Attempts: 8"),
  teamPointLabel
);
const decisionChartMarkup = renderToStaticMarkup(
  React.createElement(DecisionTradeoffCharts, { rows: chartRows })
);
check(
  "trade-off charts expose overall-index terminology and full identity legend",
  decisionChartMarkup.includes(
    "Overall index vs tokens per successful case"
  ) &&
    decisionChartMarkup.includes(
      "Overall index vs time per successful case"
    ) &&
    decisionChartMarkup.includes("Overall index") &&
    decisionChartMarkup.includes("Alpha Model · Low") &&
    decisionChartMarkup.includes("Beta Builder Team") &&
    decisionChartMarkup.includes("Solo model") &&
    decisionChartMarkup.includes("Team"),
  decisionChartMarkup
);
check(
  "trade-off charts retain accessible data values",
  decisionChartMarkup.includes("84.0") &&
    decisionChartMarkup.includes("77.0") &&
    decisionChartMarkup.includes("1,234") &&
    decisionChartMarkup.includes("5,678") &&
    decisionChartMarkup.includes("2.5s") &&
    decisionChartMarkup.includes("9.3s"),
  decisionChartMarkup
);
const pointShapeMarkup = renderToStaticMarkup(
  React.createElement(
    "svg",
    null,
    React.createElement(DecisionTradeoffPointShape, {
      cx: 24,
      cy: 36,
      payload: tokenProjection[1],
      xLabel: "Tokens per successful case",
      formatX: (value: number) =>
        `${Math.round(value).toLocaleString()} tokens`,
    })
  )
);
check(
  "trade-off point shape is keyboard focusable and identity-rich",
  pointShapeMarkup.includes('tabindex="0"') &&
    pointShapeMarkup.includes('aria-label="') &&
    pointShapeMarkup.includes("Beta Builder Team") &&
    pointShapeMarkup.includes("Overall index: 77.0") &&
    pointShapeMarkup.includes("Tokens per successful case: 5,678 tokens"),
  pointShapeMarkup
);
check(
  "chart tooltips and accessible tables distinguish team effort configs",
  chartMarkup.includes("architect: Model · Low") &&
    chartMarkup.includes("worker: Model · Low") &&
    chartMarkup.includes("architect: Model · High") &&
    chartMarkup.includes("worker: Model · High"),
  chartMarkup
);
check(
  "chart tooltip label includes canonical team roster effort",
  decisionTradeoffPointLabel({
    label: "Same team",
    reasoningEffortDetails: [
      { role: "architect", displayName: "Model", effort: "low" },
      { role: "worker", displayName: "Model", effort: "low" },
    ],
  }) ===
    "Same team — architect: Model · Low, worker: Model · Low",
  decisionTradeoffPointLabel({
    label: "Same team",
    reasoningEffortDetails: [
      { role: "architect", displayName: "Model", effort: "low" },
      { role: "worker", displayName: "Model", effort: "low" },
    ],
  })
);

const lowTeamDetails: BenchmarkVariantRosterDetail[] = [
  { role: "architect", displayName: "Model", effort: "low" },
  { role: "worker", displayName: "Model", effort: "low" },
];
const highTeamDetails: BenchmarkVariantRosterDetail[] = [
  { role: "architect", displayName: "Model", effort: "high" },
  { role: "worker", displayName: "Model", effort: "high" },
];
const teamIqBase: TeamIqComboMatrixRow = {
  id: "same-team-low:teamiq",
  teamCompositionId: "same-team-low",
  teamName: "Same team",
  comboHash: "same-team-low",
  track: "teamiq",
  modelIds: ["openai:model"],
  modelVariantKeys: ["openai:model\u0000low"],
  reasoningEffortDetails: lowTeamDetails,
  isSolo: false,
  attempts: 3,
  verifiedQuality: 0.8,
  jobSuccessScore: 80,
  costUsd: 1,
  averageCostUsd: 1,
  durationMs: 1000,
  averageDurationMs: 1000,
  bestSoloScore: 70,
  teamLift: 10,
  teamLiftLabel: "positive",
  isParetoRecommended: true,
  recommendationLabel: "recommended",
};
const teamIqRows: TeamIqComboMatrixRow[] = [
  teamIqBase,
  {
    ...teamIqBase,
    id: "same-team-high:teamiq",
    teamCompositionId: "same-team-high",
    comboHash: "same-team-high",
    modelVariantKeys: ["openai:model\u0000high"],
    reasoningEffortDetails: highTeamDetails,
    verifiedQuality: 0.9,
  },
];
const teamIqCards: TeamIqRecommendationCard[] = [
  {
    kind: "best_team_lift",
    title: "Best team lift",
    teamCompositionId: "same-team-low",
    teamName: "Same team",
    value: "+10",
    detail: "Low team",
    recommendationLabel: "recommended",
    reasoningEffortDetails: lowTeamDetails,
  },
  {
    kind: "best_quality",
    title: "Best quality",
    teamCompositionId: "same-team-high",
    teamName: "Same team",
    value: "90%",
    detail: "High team",
    recommendationLabel: "recommended",
    reasoningEffortDetails: highTeamDetails,
  },
];
const comboMarkup = renderToStaticMarkup(
  React.createElement(ComboMatrix, { rows: teamIqRows })
);
check(
  "combo matrix distinguishes otherwise identical team effort configs",
  comboMarkup.includes("architect: Model · Low") &&
    comboMarkup.includes("worker: Model · Low") &&
    comboMarkup.includes("architect: Model · High") &&
    comboMarkup.includes("worker: Model · High"),
  comboMarkup
);
const paretoMarkup = renderToStaticMarkup(
  React.createElement(ParetoFrontier, {
    rows: teamIqRows,
    cards: teamIqCards,
  })
);
check(
  "Pareto rows and recommendation cards distinguish team effort configs",
  paretoMarkup.includes("architect: Model · Low") &&
    paretoMarkup.includes("worker: Model · Low") &&
    paretoMarkup.includes("architect: Model · High") &&
    paretoMarkup.includes("worker: Model · High"),
  paretoMarkup
);
const recommendationOnlyMarkup = renderToStaticMarkup(
  React.createElement(ParetoFrontier, {
    rows: [],
    cards: teamIqCards,
  })
);
check(
  "recommendation cards independently distinguish team effort configs",
  recommendationOnlyMarkup.includes("architect: Model · Low") &&
    recommendationOnlyMarkup.includes("worker: Model · Low") &&
    recommendationOnlyMarkup.includes("architect: Model · High") &&
    recommendationOnlyMarkup.includes("worker: Model · High"),
  recommendationOnlyMarkup
);

const overallMarkup = renderToStaticMarkup(
  React.createElement(CertifiedBenchmarkOverview, {
    certified: {
      modelIntelligence: [
        {
          modelId: "openai:model",
          reasoningEffort: "low",
          variantKey: "openai:model\u0000low",
          displayName: "Model · Low",
          attempts: 2,
          passed: 1,
          verifiedPassRate: 0.5,
          combinedScore: 0.7,
          trackCount: 1,
          preliminary: true,
          tracks: [],
        },
        {
          modelId: "openai:model",
          reasoningEffort: "high",
          variantKey: "openai:model\u0000high",
          displayName: "Model · High",
          attempts: 3,
          passed: 3,
          verifiedPassRate: 1,
          combinedScore: 0.9,
          trackCount: 1,
          preliminary: false,
          tracks: [],
        },
      ],
      leaderboard: [],
    },
    counts: {
      suites: 0,
      runs: 0,
      cases: 0,
      attempts: 0,
      metricValues: 0,
      artifacts: 0,
      failures: 0,
      traces: 0,
      certifiedCases: 1,
      certifiedAttempts: 5,
      verifierResults: 0,
      runEvents: 0,
      toolCallTraces: 0,
      teamCompositions: 2,
      harnessCertifications: 0,
    },
  })
);
check(
  "overall ranking renders same-model effort siblings",
  overallMarkup.includes("Model · Low") && overallMarkup.includes("Model · High"),
  overallMarkup
);
check(
  "overall ranking keys rows by canonical variant identity",
  source("components/benchmark/certified/CertifiedBenchmarkOverview.tsx").includes(
    "key={row.variantKey}"
  ),
  source("components/benchmark/certified/CertifiedBenchmarkOverview.tsx")
);

for (const label of [
  "Best overall model",
  "Best WorkBench team",
  "Most reliable",
  "Leanest successful model",
  "Fastest successful model",
  "Best team lift",
]) {
  check(`decision verdict exposes ${label}`, verdicts.includes(label), label);
}

check(
  "index ribbon names and explains Certified Index v1.0",
  ribbon.includes("CERTIFIED_INDEX_VERSION") &&
    decisionModel.includes('CERTIFIED_INDEX_VERSION = "Certified Index v1.0"') &&
    ribbon.includes("Equal weight per completed track") &&
    ribbon.includes("Missing tracks are not scored as zero"),
  ribbon
);

for (const label of ["Search evidence", "Track", "Run type", "Provider", "Reasoning", "Evidence"]) {
  check(`decision filter exposes ${label}`, filters.includes(label), label);
}

check(
  "leaderboard presents confidence and profile actions",
  leaderboard.includes("95% range") &&
    leaderboard.includes("View profile") &&
    leaderboard.includes("aria-controls") &&
    leaderboard.includes("rankMetricLabel(sortKey)") &&
    leaderboard.includes("formatRankMetric(row, sortKey)"),
  leaderboard
);
check(
  "tool reliability keeps its native 0-100 point scale",
  verdicts.includes("formatScore(verdict.metric)") &&
    leaderboard.includes("formatPointScore(row.toolReliabilityScore)"),
  { verdicts, leaderboard }
);
check(
  "profile explains coverage, per-track pass evidence, and efficiency",
  profile.includes("Evidence profile") &&
    profile.includes("Track coverage") &&
    profile.includes("Evaluated cases") &&
    profile.includes("verifiedPassRate") &&
    profile.includes("Tool reliability") &&
    profile.includes("Efficiency") &&
    profile.includes("formatMaybeScore(track.averageVerifiedQuality)"),
  profile
);
check(
  "profile renders inline with the selected leaderboard row",
  leaderboard.includes("<ModelEvidenceProfile") &&
    leaderboard.includes("colSpan={8}") &&
    !dashboard.includes("<ModelEvidenceProfile"),
  { dashboard, leaderboard }
);
check(
  "understand layer contains both decision trade-off charts",
  charts.includes("Overall index vs tokens per successful case") &&
    charts.includes("Overall index vs time per successful case") &&
    charts.includes("Accessible data"),
  charts
);
check(
  "dashboard separates Decide and Understand layers",
  dashboard.includes("What the evidence says") &&
    dashboard.includes("Understand the trade-offs"),
  dashboard
);
check(
  "benchmark page labels the operational disclosure as Audit evidence",
  page.includes("Audit evidence") && page.includes("BenchmarkDecisionDashboard"),
  page
);
check(
  "standard benchmark unit command includes the decision UI contract",
  packageJson.includes(
    "tsx scripts/test-benchmark-decision-dashboard.mts && tsx scripts/test-benchmark-decision-dashboard-ui.mts"
  ),
  packageJson
);
check(
  "index ribbon accounts for HarnessBench evidence",
  ribbon.includes("HarnessBench") && filters.includes('value === "harnessbench"'),
  { ribbon, filters }
);

if (failures > 0) process.exit(1);
console.log("PASS");

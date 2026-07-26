/* Decision dashboard UI contract checks (run: npx tsx scripts/test-benchmark-decision-dashboard-ui.mts) */
import { existsSync, readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionLeaderboard } from "../components/benchmark/results/DecisionLeaderboard";
import { DecisionVerdicts } from "../components/benchmark/results/DecisionVerdicts";
import {
  DecisionTradeoffPointShape,
  DecisionTradeoffTooltip,
  DecisionTradeoffCharts,
  decisionTradeoffPointAriaLabel,
  decisionTradeoffPointLabel,
  projectDecisionTradeoffPoints
} from "../components/benchmark/results/DecisionTradeoffCharts";
import { chartColorForIdentity } from "../components/benchmark/chart-utils";
import { ModelEvidenceProfile } from "../components/benchmark/results/ModelEvidenceProfile";
import {
  CertifiedLeaderboard,
  WorkBenchRoleLeaderboards,
  type RosterRole
} from "../components/benchmark/certified/CertifiedResultTables";
import { CertifiedBenchmarkOverview } from "../components/benchmark/certified/CertifiedBenchmarkOverview";
import { ComboMatrix } from "../components/benchmark/teamiq/ComboMatrix";
import { ParetoFrontier } from "../components/benchmark/teamiq/ParetoFrontier";
import type { DecisionRow } from "../lib/benchmark/certified/decision-dashboard";
import type { TeamIqComboMatrixRow, TeamIqRecommendationCard } from "../lib/benchmark/teamiq";
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
  teamLiftTracks: [],
  teamCompositionId: "variant-low",
  modelIds: ["openai:model"],
  isTeam: false,
  latestAttemptsByTrack: {},
  providerUnavailableAttemptIds: [],
  providerUnavailableAttemptIdsByTrack: {},
  providerIds: ["openai"],
  reasoningEfforts: ["low"],
  reasoningEffortDetails: [],
  failureDetails: []
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
        reasoningEfforts: ["high"]
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
          { role: "worker", displayName: "Worker", effort: "high" }
        ]
      }
    ],
    totalRows: 3,
    sortKey: "quality",
    onSortChange: () => undefined,
    selectedId: null,
    onSelect: () => undefined
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
        { role: "worker", displayName: "Worker", effort: "high" }
      ]
    },
    onClose: () => undefined
  })
);
check(
  "team profile renders effort beside each roster role",
  teamProfileMarkup.includes("architect: Architect · Low") &&
    teamProfileMarkup.includes("worker: Worker · High"),
  teamProfileMarkup
);

const responsiveRows: DecisionRow[] = [
  {
    ...variantRow,
    id: "responsive-solo",
    label: "A deliberately long solo model identity that must wrap in full",
    tracks: ["gameiq"],
    caseTitles: ["Solo evidence case"],
    attempts: 4,
    passed: 3,
    preliminary: false,
    verifiedQuality: 0.75,
    overallScore: 0.72,
    passRate: 0.75,
    toolReliabilityScore: 84,
    tokensPerPass: 1234,
    speedPerPassMs: 2500,
    trackBreakdown: [
      {
        track: "gameiq",
        attempts: 4,
        passed: 3,
        verifiedPassRate: 0.75,
        averageVerifiedQuality: 0.72
      }
    ]
  },
  {
    ...variantRow,
    id: "responsive-team",
    label: "Architect and worker evidence team",
    tracks: ["workbench"],
    caseTitles: ["Team evidence case"],
    attempts: 2,
    passed: 1,
    preliminary: true,
    verifiedQuality: 0.5,
    overallScore: 0.48,
    passRate: 0.5,
    isTeam: true,
    modelIds: ["openai:architect", "openai:worker"],
    teamCompositionId: "responsive-team",
    teamLift: 0,
    teamLiftTracks: [],
    trackBreakdown: [
      {
        track: "workbench",
        attempts: 2,
        passed: 1,
        verifiedPassRate: 0.5,
        averageVerifiedQuality: 0.48
      }
    ]
  },
  {
    ...variantRow,
    id: "responsive-failed-budget",
    label: "Budget-limited model",
    tracks: ["harnessbench"],
    caseTitles: ["Budget evidence case"],
    attempts: 1,
    passed: 0,
    verifiedQuality: 0,
    overallScore: 0,
    passRate: 0,
    latestAttemptStatus: "failed_budget",
    latestAttemptTrack: "harnessbench",
    latestAttemptsByTrack: {
      harnessbench: {
        id: "budget-attempt",
        status: "failed_budget",
        track: "harnessbench"
      }
    },
    failureDetails: [],
    trackBreakdown: [
      {
        track: "harnessbench",
        attempts: 1,
        passed: 0,
        verifiedPassRate: 0,
        averageVerifiedQuality: 0
      }
    ]
  },
  {
    ...variantRow,
    id: "responsive-failed-tool",
    label: "Tool-failed model",
    tracks: ["toolreliability"],
    attempts: 2,
    passed: 1,
    failureDetails: [
      {
        attemptId: "tool-attempt",
        track: "toolreliability",
        status: "failed_tool_use",
        code: "tool_contract",
        message: "Required tool output was malformed."
      },
      {
        attemptId: "tool-attempt-repeat",
        track: "toolreliability",
        status: "failed_tool_use",
        code: "tool_contract",
        message: "Required tool output was malformed."
      }
    ]
  }
];
const responsiveLeaderboardMarkup = renderToStaticMarkup(
  React.createElement(DecisionLeaderboard, {
    rows: responsiveRows,
    totalRows: responsiveRows.length,
    sortKey: "teamLift",
    onSortChange: () => undefined,
    selectedId: null,
    onSelect: () => undefined
  })
);
const mobileListStart = responsiveLeaderboardMarkup.indexOf('<ul class="md:hidden">');
const responsiveDesktopMarkup = responsiveLeaderboardMarkup.slice(0, mobileListStart);
const responsiveMobileMarkup = responsiveLeaderboardMarkup.slice(mobileListStart);
check(
  "leaderboard renders complementary desktop table and mobile evidence list",
  responsiveLeaderboardMarkup.includes('class="hidden overflow-x-auto md:block"') &&
    responsiveLeaderboardMarkup.includes('class="md:hidden"') &&
    responsiveRows.every((row) => responsiveLeaderboardMarkup.split(row.label).length - 1 === 2),
  responsiveLeaderboardMarkup
);
check(
  "mobile evidence cards preserve full identities and core decision metrics",
  responsiveMobileMarkup.includes(
    '<h3 class="break-words text-base font-semibold">A deliberately long solo model identity that must wrap in full</h3>'
  ) &&
    [
      "Overall index",
      "Pass \u00b7 95% range",
      "Coverage",
      "Reliability",
      "Tokens/pass",
      "Time/pass",
      "View profile"
    ].every((label) => responsiveMobileMarkup.includes(label)),
  responsiveMobileMarkup
);
check(
  "mobile rows surface persisted and certified budget evidence",
  responsiveMobileMarkup.includes("Failure evidence") &&
    responsiveMobileMarkup.includes("Tool Reliability") &&
    responsiveMobileMarkup.includes("Required tool output was malformed.") &&
    responsiveMobileMarkup.includes("Certified budget exhausted before this track completed."),
  responsiveMobileMarkup
);
check(
  "numeric legacy team lift without comparison tracks is unavailable in both layouts",
  responsiveDesktopMarkup.includes("Not comparable") &&
    responsiveDesktopMarkup.includes("Run the same track solo and as a team.") &&
    responsiveMobileMarkup.includes("Not comparable") &&
    responsiveMobileMarkup.includes("Run the same track solo and as a team.") &&
    !responsiveDesktopMarkup.includes("+0") &&
    !responsiveMobileMarkup.includes("+0"),
  { responsiveDesktopMarkup, responsiveMobileMarkup }
);

const collidingIdentityRows: DecisionRow[] = [
  { ...responsiveRows[0], id: "a:b", label: "Colon identity" },
  { ...responsiveRows[0], id: "a/b", label: "Slash identity" }
];
const selectedResponsiveMarkup = renderToStaticMarkup(
  React.createElement(DecisionLeaderboard, {
    rows: collidingIdentityRows,
    totalRows: collidingIdentityRows.length,
    sortKey: "overall",
    onSortChange: () => undefined,
    selectedId: collidingIdentityRows[0].id,
    onSelect: () => undefined
  })
);
check(
  "arbitrary row identities have injective desktop and mobile profile ids",
  selectedResponsiveMarkup.includes(
    'aria-controls="benchmark-evidence-desktop-u-000061-00003a-000062"'
  ) &&
    selectedResponsiveMarkup.includes(
      'aria-controls="benchmark-evidence-mobile-u-000061-00003a-000062"'
    ) &&
    selectedResponsiveMarkup.includes(
      'aria-controls="benchmark-evidence-desktop-u-000061-00002f-000062"'
    ) &&
    selectedResponsiveMarkup.includes(
      'aria-controls="benchmark-evidence-mobile-u-000061-00002f-000062"'
    ) &&
    selectedResponsiveMarkup.includes(
      'id="benchmark-evidence-desktop-u-000061-00003a-000062"'
    ) &&
    selectedResponsiveMarkup.includes(
      'id="benchmark-evidence-mobile-u-000061-00003a-000062"'
    ) &&
    selectedResponsiveMarkup.match(/role="region"/g)?.length === 2,
  selectedResponsiveMarkup
);

const explanatoryProfileMarkup = renderToStaticMarkup(
  React.createElement(ModelEvidenceProfile, {
    id: "explanatory-profile",
    row: {
      ...responsiveRows[2],
      failureDetails: [
        {
          attemptId: "budget-attempt",
          track: "harnessbench",
          status: "failed_budget",
          code: "budget_exhausted",
          message: "Certified model-call budget was exhausted."
        },
        {
          attemptId: "budget-attempt-repeat",
          track: "harnessbench",
          status: "failed_budget",
          code: "budget_exhausted",
          message: "Certified model-call budget was exhausted."
        }
      ]
    },
    onClose: () => undefined
  })
);
check(
  "evidence profile names and explains the certified index",
  explanatoryProfileMarkup.includes("Overall index") &&
    !explanatoryProfileMarkup.includes("Overall quality") &&
    explanatoryProfileMarkup.includes(
      "Certified Index v1.0 averages these per-track scores with equal weight."
    ) &&
    explanatoryProfileMarkup.includes("Missing tracks are not scored as zero."),
  explanatoryProfileMarkup
);
check(
  "track profile counts passes and budget failures and deduplicates messages",
  explanatoryProfileMarkup.includes("0 of 1 passed") &&
    explanatoryProfileMarkup.includes("2 budget failures") &&
    explanatoryProfileMarkup.split("Certified model-call budget was exhausted.").length - 1 === 1,
  explanatoryProfileMarkup
);

const missingEvidenceProfileMarkup = renderToStaticMarkup(
  React.createElement(ModelEvidenceProfile, {
    id: "missing-evidence-profile",
    row: {
      ...responsiveRows[0],
      overallScore: null,
      verifiedQuality: 0.91,
      trackBreakdown: [
        {
          track: "gameiq",
          attempts: 3,
          passed: null,
          verifiedPassRate: null,
          averageVerifiedQuality: 0.91
        }
      ]
    },
    onClose: () => undefined
  })
);
const overallIndexMetricStart = missingEvidenceProfileMarkup.indexOf(">Overall index<");
const overallIndexMetricMarkup = missingEvidenceProfileMarkup.slice(
  overallIndexMetricStart,
  missingEvidenceProfileMarkup.indexOf("</div></div>", overallIndexMetricStart)
);
check(
  "profile does not substitute verified quality for a missing overall index",
  overallIndexMetricMarkup.includes("Unavailable") && !overallIndexMetricMarkup.includes("91"),
  overallIndexMetricMarkup
);
check(
  "track profile preserves unavailable pass evidence",
  missingEvidenceProfileMarkup.includes("3 attempts \u00b7 Pass evidence unavailable") &&
    !missingEvidenceProfileMarkup.includes("0 of 3 passed"),
  missingEvidenceProfileMarkup
);

const unbrokenProfileIdentity = "model_" + "x".repeat(160);
const unbrokenProfileMarkup = renderToStaticMarkup(
  React.createElement(ModelEvidenceProfile, {
    id: "unbroken-profile",
    row: { ...responsiveRows[0], label: unbrokenProfileIdentity },
    onClose: () => undefined
  })
);
const unbrokenTitlePosition = unbrokenProfileMarkup.indexOf(unbrokenProfileIdentity);
const unbrokenTitleMarkup = unbrokenProfileMarkup.slice(
  Math.max(0, unbrokenTitlePosition - 220),
  unbrokenTitlePosition + unbrokenProfileIdentity.length
);
check(
  "profile title constrains and wraps an unbroken identity",
  unbrokenTitleMarkup.includes("min-w-0") && unbrokenTitleMarkup.includes("break-words"),
  unbrokenTitleMarkup
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
      averageVerifiedQuality: 0.9
    }
  ],
  reasoningEfforts: ["low", "high"],
  reasoningEffortDetails: [
    { role: "architect", displayName: "Architect", effort: "low" },
    { role: "worker", displayName: "Worker", effort: "high" },
    { role: "reviewer", displayName: "Legacy", effort: "invalid" as never }
  ]
};
const verdictMarkup = renderToStaticMarkup(
  React.createElement(DecisionVerdicts, {
    rows: [variantRow, teamDecisionRow]
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
    rows: [variantRow]
  })
);
check(
  "empty WorkBench and team-lift cards request comparable team evidence",
  emptyTeamVerdictMarkup.includes("Run a team WorkBench pack to compare verified coding work.") &&
    emptyTeamVerdictMarkup.includes(
      "Run the same certified track solo and as a team to measure added value."
    ),
  emptyTeamVerdictMarkup
);

const rosterRoles: RosterRole[] = [
  { role: "architect", displayName: "Architect", reasoningEffort: "low" },
  { role: "worker", displayName: "Worker", reasoningEffort: "high" },
  { role: "reviewer", displayName: "Legacy", reasoningEffort: "default" }
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
    rosterByTeamId: new Map([["team-winner", rosterRoles]])
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
    onDeleteProviderErrors: () => undefined
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
          averageDurationMs: null
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
          averageDurationMs: null
        }
      ],
      worker: [],
      reviewer: []
    }
  })
);
check(
  "WorkBench role table renders same-model effort siblings",
  roleBoardsMarkup.includes("Model · Low") && roleBoardsMarkup.includes("Model · High"),
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
          { role: "worker", displayName: "Model", effort: "low" }
        ]
      },
      {
        ...teamDecisionRow,
        id: "same-team-high",
        label: "Same team",
        tokensPerPass: 2000,
        speedPerPassMs: 2000,
        reasoningEffortDetails: [
          { role: "architect", displayName: "Model", effort: "high" },
          { role: "worker", displayName: "Model", effort: "high" }
        ]
      }
    ]
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
    speedPerPassMs: 2500
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
    speedPerPassMs: 9250
  }
];
const tokenProjection = projectDecisionTradeoffPoints(chartRows, "tokens");
const timeProjection = projectDecisionTradeoffPoints(chartRows, "time");
const reorderedProjection = projectDecisionTradeoffPoints([chartRows[1]!, chartRows[0]!], "tokens");
const filteredProjection = projectDecisionTradeoffPoints([chartRows[1]!], "tokens");
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
  "trade-off plot groups preserve semantics for focusable point descendants",
  decisionChartMarkup.includes('class="h-72" role="group"') &&
    !decisionChartMarkup.includes('class="h-72" role="img"'),
  decisionChartMarkup
);
check(
  "trade-off charts expose overall-index terminology and full identity legend",
  decisionChartMarkup.includes("Overall index vs tokens per successful case") &&
    decisionChartMarkup.includes("Overall index vs time per successful case") &&
    decisionChartMarkup.includes("Overall index") &&
    decisionChartMarkup.includes("Alpha Model · Low") &&
    decisionChartMarkup.includes("Beta Builder Team") &&
    decisionChartMarkup.includes("Solo model") &&
    decisionChartMarkup.includes("Team"),
  decisionChartMarkup
);
const longChartIdentity =
  "Alpha Model With A Deliberately Long Provider And Reasoning Configuration Name";
const longLegendMarkup = renderToStaticMarkup(
  React.createElement(DecisionTradeoffCharts, {
    rows: [{ ...chartRows[0]!, label: longChartIdentity }]
  })
);
check(
  "trade-off legend wraps and preserves a full long identity",
  longLegendMarkup.includes(longChartIdentity) &&
    longLegendMarkup.includes('class="min-w-0 break-words whitespace-normal font-medium"') &&
    !longLegendMarkup.includes('class="truncate font-medium"'),
  longLegendMarkup
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
      formatX: (value: number) => `${Math.round(value).toLocaleString()} tokens`
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
const tooltipMarkup = renderToStaticMarkup(
  React.createElement(DecisionTradeoffTooltip, {
    active: true,
    payload: [
      {
        graphicalItemId: "decision-tradeoff",
        dataKey: "quality",
        name: "Overall index",
        value: tokenProjection[1]!.quality,
        color: tokenProjection[1]!.color,
        payload: tokenProjection[1]
      }
    ],
    xLabel: "Tokens per successful case",
    formatX: (value: number) => `${Math.round(value).toLocaleString()} tokens`
  })
);
check(
  "active trade-off tooltip renders complete identity and decision evidence",
  tooltipMarkup.includes("Beta Builder Team") &&
    tooltipMarkup.includes("architect: Architect · Low") &&
    tooltipMarkup.includes("Team") &&
    tooltipMarkup.includes("WorkBench, TeamIQ") &&
    tooltipMarkup.includes("Overall index") &&
    tooltipMarkup.includes("77.0") &&
    tooltipMarkup.includes("Tokens per successful case") &&
    tooltipMarkup.includes("5,678 tokens") &&
    tooltipMarkup.includes("Attempts") &&
    tooltipMarkup.includes(">8<"),
  tooltipMarkup
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
      { role: "worker", displayName: "Model", effort: "low" }
    ]
  }) === "Same team — architect: Model · Low, worker: Model · Low",
  decisionTradeoffPointLabel({
    label: "Same team",
    reasoningEffortDetails: [
      { role: "architect", displayName: "Model", effort: "low" },
      { role: "worker", displayName: "Model", effort: "low" }
    ]
  })
);

const lowTeamDetails: BenchmarkVariantRosterDetail[] = [
  { role: "architect", displayName: "Model", effort: "low" },
  { role: "worker", displayName: "Model", effort: "low" }
];
const highTeamDetails: BenchmarkVariantRosterDetail[] = [
  { role: "architect", displayName: "Model", effort: "high" },
  { role: "worker", displayName: "Model", effort: "high" }
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
  recommendationLabel: "recommended"
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
    verifiedQuality: 0.9
  }
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
    reasoningEffortDetails: lowTeamDetails
  },
  {
    kind: "best_quality",
    title: "Best quality",
    teamCompositionId: "same-team-high",
    teamName: "Same team",
    value: "90%",
    detail: "High team",
    recommendationLabel: "recommended",
    reasoningEffortDetails: highTeamDetails
  }
];
const comboMarkup = renderToStaticMarkup(React.createElement(ComboMatrix, { rows: teamIqRows }));
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
    cards: teamIqCards
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
    cards: teamIqCards
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
          tracks: []
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
          tracks: []
        }
      ],
      leaderboard: []
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
      harnessCertifications: 0
    }
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
  "Best team lift"
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
  dashboard.includes("What the evidence says") && dashboard.includes("Understand the trade-offs"),
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

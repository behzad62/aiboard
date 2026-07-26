/* Decision dashboard UI contract checks (run: npx tsx scripts/test-benchmark-decision-dashboard-ui.mts) */
import { existsSync, readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionLeaderboard } from "../components/benchmark/results/DecisionLeaderboard";
import { ModelEvidenceProfile } from "../components/benchmark/results/ModelEvidenceProfile";
import type { DecisionRow } from "../lib/benchmark/certified/decision-dashboard";

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
};
const leaderboardMarkup = renderToStaticMarkup(
  React.createElement(DecisionLeaderboard, {
    rows: [variantRow],
    totalRows: 1,
    sortKey: "quality",
    onSortChange: () => undefined,
    selectedId: null,
    onSelect: () => undefined,
  })
);
check(
  "leaderboard renders the effort-aware solo variant label",
  leaderboardMarkup.includes("Model · Low"),
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

for (const label of [
  "Best overall model",
  "Best WorkBench model",
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
  charts.includes("Quality vs tokens per successful case") &&
    charts.includes("Quality vs time per successful case") &&
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

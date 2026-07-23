/* Decision dashboard selector checks (run: npx tsx scripts/test-benchmark-decision-dashboard.mts) */
import {
  buildDecisionVerdicts,
  filterDecisionRows,
  sortDecisionRows,
  wilsonInterval,
  type DecisionFilters,
  type DecisionRow,
} from "../lib/benchmark/certified/decision-dashboard";

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
    teamCompositionId: id,
    modelIds: [id],
    isTeam: false,
    latestAttemptsByTrack: {},
    providerUnavailableAttemptIds: [],
    providerUnavailableAttemptIdsByTrack: {},
    providerIds: [],
    reasoningEfforts: [],
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
  row("sol", {
    label: "GPT-5.6 Sol",
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
  row("reliable", { toolReliabilityScore: 99, toolReliabilitySamples: 7 }),
  row("lean", { tokensPerPass: 900, passed: 4 }),
  row("fast", { speedPerPassMs: 750, passed: 5 }),
  row("lift", { modelIds: ["a", "b"], isTeam: true, teamLift: 18 }),
];
const verdicts = buildDecisionVerdicts(verdictRows);
const winners = Object.fromEntries(verdicts.map((verdict) => [verdict.key, verdict.winner?.id]));
check("best overall winner uses solo overall score", winners.overall === "overall", winners);
check("best WorkBench winner uses WorkBench quality", winners.workbench === "workbench", winners);
check("most reliable winner uses tool reliability", winners.reliability === "reliable", winners);
check("leanest winner minimizes tokens per pass", winners.leanest === "lean", winners);
check("fastest winner minimizes time per pass", winners.fastest === "fast", winners);
check("best team lift only considers teams", winners.teamLift === "lift", winners);
const verdictByKey = Object.fromEntries(verdicts.map((verdict) => [verdict.key, verdict]));
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

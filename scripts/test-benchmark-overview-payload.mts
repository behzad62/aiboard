/* Certified dashboard payload wiring for the Overview UI
   (run: npx tsx scripts/test-benchmark-overview-payload.mts)

   The Overview component (components/benchmark/certified/CertifiedBenchmarkOverview.tsx)
   reads `certified.modelIntelligence` for the "Best model overall" verdict card
   and the token fields on leaderboard rows for the Tokens/Cost columns. Those
   fields are assembled in buildCertifiedBenchmarkDashboardData; this test guards
   that they are present and populated so a lib refactor can't silently blank the
   verdict card or the token efficiency axis. */
import { buildCertifiedBenchmarkDashboardData } from "../lib/benchmark/metrics";
import type {
  BenchmarkAttemptV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function soloTeam(id: string, modelId: string): BenchmarkTeamComposition {
  return {
    id,
    name: modelId,
    comboHash: `solo:${modelId}`,
    roles: [
      {
        role: "single",
        slot: "single",
        modelId,
        providerId: "test",
        displayName: modelId,
        temperature: 0,
      },
    ],
  };
}

function attempt(
  id: string,
  teamId: string,
  overrides: Partial<BenchmarkAttemptV2> = {}
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId: `case-${id}`,
    teamCompositionId: teamId,
    mode: "certified",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: "2026-07-02T10:00:00.000Z",
    completedAt: "2026-07-02T10:01:00.000Z",
    verifiedQuality: 0.8,
    jobSuccessScore: 80,
    efficiencyScore: 80,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1000,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "test",
    promptSetVersion: "test",
    scoringVersion: "certified-v0.1",
    ...overrides,
  };
}

const teamPriced = soloTeam("solo-priced", "prov:priced");
const teamTokenOnly = soloTeam("solo-token", "prov:token");

const dashboard = buildCertifiedBenchmarkDashboardData({
  caseV2: [],
  attemptsV2: [
    // Priced model, higher quality, three attempts -> confident winner.
    attempt("p1", teamPriced.id, {
      track: "gameiq",
      verifiedQuality: 0.9,
      costUsd: 0.02,
      inputTokens: 100,
      outputTokens: 50,
    }),
    attempt("p2", teamPriced.id, {
      track: "gameiq",
      verifiedQuality: 0.9,
      costUsd: 0.02,
      inputTokens: 100,
      outputTokens: 50,
    }),
    attempt("p3", teamPriced.id, {
      track: "teamiq",
      verifiedQuality: 0.7,
      costUsd: 0.02,
      inputTokens: 100,
      outputTokens: 50,
    }),
    // Token-only model (no pricing) -> efficiency axis must still work via tokens.
    attempt("t1", teamTokenOnly.id, {
      track: "gameiq",
      verifiedQuality: 0.6,
      costUsd: null,
      inputTokens: 400,
      outputTokens: 100,
    }),
  ],
  verifierResults: [],
  teamCompositions: [teamPriced, teamTokenOnly],
  harnessCertifications: [],
});

check(
  "dashboard payload carries a modelIntelligence array",
  Array.isArray(dashboard.modelIntelligence) &&
    dashboard.modelIntelligence.length === 2,
  dashboard.modelIntelligence
);

const winner = dashboard.modelIntelligence[0];
check(
  "best model is the higher cross-track combined score, not the highest single-track",
  winner?.modelId === "prov:priced" &&
    // (0.9 gameiq + 0.7 teamiq) / 2 = 0.8
    winner?.combinedScore === 0.8 &&
    winner?.trackCount === 2 &&
    winner?.preliminary === false,
  winner
);

check(
  "winner exposes per-track breakdown for the verdict card",
  winner?.tracks.length === 2 &&
    winner.tracks.every(
      (t) => typeof t.track === "string" && typeof t.averageVerifiedQuality === "number"
    ),
  winner?.tracks
);

// Leaderboard rows must carry the token fields the Overview Tokens/Cost columns
// read (totalTokens, tokensPerPass, costBasis).
const pricedRow = dashboard.leaderboard.find(
  (row) => row.teamCompositionId === teamPriced.id
);
const tokenRow = dashboard.leaderboard.find(
  (row) => row.teamCompositionId === teamTokenOnly.id
);
check(
  "priced leaderboard row exposes usd cost basis and token totals",
  pricedRow?.costBasis === "usd" &&
    pricedRow?.averageCostUsd != null &&
    pricedRow?.totalTokens === 450 &&
    pricedRow?.tokensPerPass != null,
  pricedRow
);
check(
  "token-only leaderboard row exposes tokens basis so cost column can show '— (no pricing)'",
  tokenRow?.costBasis === "tokens" &&
    tokenRow?.averageCostUsd === null &&
    tokenRow?.totalTokens === 500 &&
    tokenRow?.tokensPerPass === 500,
  tokenRow
);

// costPerPass ranking (backs the "Cost or tokens/pass" sort) puts priced rows
// ahead of token-only rows so the token fallback never leapfrogs a priced row.
check(
  "costPerPass leaderboard orders priced rows ahead of token-only rows",
  dashboard.costPerPassLeaderboard[0]?.costBasis === "usd" &&
    dashboard.costPerPassLeaderboard[
      dashboard.costPerPassLeaderboard.length - 1
    ]?.costBasis === "tokens",
  dashboard.costPerPassLeaderboard.map((r) => r.costBasis)
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);

/* Cross-track OVERALL score checks
   (run: npx tsx scripts/test-benchmark-overall-score.mts)

   CertifiedRunScore now carries an equal-weighted cross-track overallScore and a
   trackBreakdown feeding it. Unlike verifiedQuality (attempt-weighted), the
   overall score averages each track's quality FIRST and then takes a simple mean
   of those per-track averages, so a high-volume track cannot drown a low-volume
   one. This test guards the aggregate math, the null/single-track edge cases,
   the rankByOverall ordering, and that the dashboard payload carries the new
   overallLeaderboard while modelIntelligence stays intact. */
import {
  aggregateCertifiedRunScores,
  rankByOverall,
} from "../lib/benchmark/scoring/aggregate";
import { buildCertifiedBenchmarkDashboardData } from "../lib/benchmark/metrics";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
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
  track: BenchmarkAttemptV2["track"],
  verifiedQuality: number,
  overrides: Partial<BenchmarkAttemptV2> = {}
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId: `case-${id}`,
    teamCompositionId: teamId,
    mode: "certified",
    track,
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: "2026-07-02T10:00:00.000Z",
    completedAt: "2026-07-02T10:01:00.000Z",
    verifiedQuality,
    jobSuccessScore: verifiedQuality * 100,
    efficiencyScore: verifiedQuality * 100,
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

function certifiedCase(
  id: string,
  track: BenchmarkCaseV2["track"]
): BenchmarkCaseV2 {
  return {
    id,
    schemaVersion: 2,
    track,
    title: id,
    description: `${track} case`,
    difficulty: "medium",
    tags: [],
    caseVersion: "test",
    createdAt: "2026-07-02T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z",
    prompt: { userRequest: "Do the task" },
    environment: {
      type: "local-runner",
      timeoutSeconds: 600,
      network: "dependency-only",
    },
    verifier: { scorer: "verifier-json" },
    budget: {},
    scoring: { scoringVersion: "certified-v0.1", primary: "verified_quality" },
    contamination: {
      originalTask: true,
      canary: "test",
      referenceSolutionPrivate: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Equal-track weighting vs attempt-weighted mean.
// A model runs 19 WorkBench attempts at quality 0.5 and 1 GameIQ attempt at 1.0.
// - attempt-weighted verifiedQuality = (19*0.5 + 1*1.0) / 20 = 10.5/20 = 0.525
// - equal-track overallScore = (0.5 + 1.0) / 2 = 0.75
// The overall number must be the equal-weighted one, NOT drowned by WorkBench.
// ---------------------------------------------------------------------------
const lopsidedTeam = soloTeam("solo-lopsided", "prov:lopsided");
const lopsidedAttempts: BenchmarkAttemptV2[] = [
  ...Array.from({ length: 19 }, (_, i) =>
    attempt(`wb-${i}`, lopsidedTeam.id, "workbench", 0.5)
  ),
  attempt("gi-0", lopsidedTeam.id, "gameiq", 1.0),
];
const lopsidedRows = aggregateCertifiedRunScores({
  attempts: lopsidedAttempts,
  cases: [],
  teamCompositions: [lopsidedTeam],
  verifierResults: [],
});
const lopsidedRow = lopsidedRows[0];
check(
  "attempt-weighted verifiedQuality is drowned by the high-volume track",
  lopsidedRow?.verifiedQuality === 0.53 /* round(10.5/20, 2) = 0.53 */,
  lopsidedRow?.verifiedQuality
);
check(
  "overallScore weights each track equally (not drowned by 19 WorkBench attempts)",
  lopsidedRow?.overallScore === 0.75,
  { overallScore: lopsidedRow?.overallScore, breakdown: lopsidedRow?.trackBreakdown }
);
check(
  "trackBreakdown has one equal-weighted entry per track, sorted by track",
  lopsidedRow?.trackBreakdown.length === 2 &&
    lopsidedRow.trackBreakdown[0]?.track === "gameiq" &&
    lopsidedRow.trackBreakdown[0]?.attempts === 1 &&
    lopsidedRow.trackBreakdown[0]?.averageVerifiedQuality === 1 &&
    lopsidedRow.trackBreakdown[1]?.track === "workbench" &&
    lopsidedRow.trackBreakdown[1]?.attempts === 19 &&
    lopsidedRow.trackBreakdown[1]?.averageVerifiedQuality === 0.5,
  lopsidedRow?.trackBreakdown
);

// ---------------------------------------------------------------------------
// Single-track passthrough: overallScore equals that track's average quality.
// ---------------------------------------------------------------------------
const singleTeam = soloTeam("solo-single", "prov:single");
const singleRows = aggregateCertifiedRunScores({
  attempts: [
    attempt("s1", singleTeam.id, "gameiq", 0.8),
    attempt("s2", singleTeam.id, "gameiq", 0.6),
  ],
  cases: [],
  teamCompositions: [singleTeam],
  verifierResults: [],
});
const singleRow = singleRows[0];
check(
  "single-track overallScore equals that track's average verified quality",
  singleRow?.overallScore === 0.7 &&
    singleRow?.verifiedQuality === 0.7 &&
    singleRow?.trackBreakdown.length === 1,
  singleRow
);

// ---------------------------------------------------------------------------
// Null case: a team with no scored attempts yields no row (so there is nothing
// to average). Assert the aggregate simply produces no row for it, and that an
// empty attempt set yields an empty leaderboard (no overallScore to compute).
// ---------------------------------------------------------------------------
const emptyRows = aggregateCertifiedRunScores({
  attempts: [],
  cases: [],
  teamCompositions: [soloTeam("solo-empty", "prov:empty")],
  verifierResults: [],
});
check(
  "no scored attempts -> no leaderboard row (nothing to average, no overall)",
  emptyRows.length === 0,
  emptyRows
);

// ---------------------------------------------------------------------------
// rankByOverall: preliminary demoted, nulls last, then overall score desc.
// ---------------------------------------------------------------------------
const ranked = rankByOverall([
  { id: "a", displayName: "A", overallScore: 0.9, verifiedQuality: 0.9, attempts: 5, preliminary: false },
  { id: "b", displayName: "B", overallScore: 0.95, verifiedQuality: 0.95, attempts: 1, preliminary: true },
  { id: "c", displayName: "C", overallScore: null, verifiedQuality: 0.4, attempts: 4, preliminary: false },
  { id: "d", displayName: "D", overallScore: 0.7, verifiedQuality: 0.7, attempts: 6, preliminary: false },
]);
check(
  "rankByOverall: mature high-overall first, preliminary demoted, null last",
  ranked.map((r) => r.id).join(",") === "a,d,c,b",
  ranked.map((r) => ({ id: r.id, overall: r.overallScore, prelim: r.preliminary }))
);

// ---------------------------------------------------------------------------
// Dashboard payload: carries overallLeaderboard AND modelIntelligence intact,
// and leaderboard rows carry overallScore + trackBreakdown.
// ---------------------------------------------------------------------------
const teamA = soloTeam("solo-a", "prov:a");
const teamB = soloTeam("solo-b", "prov:b");
const dashboard = buildCertifiedBenchmarkDashboardData({
  caseV2: [
    certifiedCase("case-a-wb", "workbench"),
    certifiedCase("case-a-gi", "gameiq"),
    certifiedCase("case-b-wb", "workbench"),
  ],
  attemptsV2: [
    attempt("a-wb", teamA.id, "workbench", 0.6, { caseId: "case-a-wb" }),
    attempt("a-gi", teamA.id, "gameiq", 1.0, { caseId: "case-a-gi" }),
    attempt("b-wb1", teamB.id, "workbench", 0.7, { caseId: "case-b-wb" }),
    attempt("b-wb2", teamB.id, "workbench", 0.7, { caseId: "case-b-wb" }),
    attempt("b-wb3", teamB.id, "workbench", 0.7, { caseId: "case-b-wb" }),
  ],
  verifierResults: [],
  teamCompositions: [teamA, teamB],
  harnessCertifications: [],
});

check(
  "dashboard payload carries an overallLeaderboard array",
  Array.isArray(dashboard.overallLeaderboard) &&
    dashboard.overallLeaderboard.length === 2,
  dashboard.overallLeaderboard.length
);

// Team A: overall = (workbench 0.6 + gameiq 1.0) / 2 = 0.8, two tracks.
// Team B: overall = workbench 0.7 only (single track, 3 attempts) = 0.7.
// So overall ranking puts A (0.8) ahead of B (0.7) despite A's thin evidence
// being NOT preliminary (2 attempts < 3 -> A IS preliminary; B has 3 -> mature).
// Preliminary demotion therefore ranks B first.
const overallFirst = dashboard.overallLeaderboard[0];
const overallSecond = dashboard.overallLeaderboard[1];
check(
  "overall ranking demotes the preliminary (2-attempt) row below the mature one",
  overallFirst?.teamCompositionId === teamB.id &&
    overallFirst?.overallScore === 0.7 &&
    overallFirst?.preliminary === false &&
    overallSecond?.teamCompositionId === teamA.id &&
    overallSecond?.overallScore === 0.8 &&
    overallSecond?.preliminary === true,
  dashboard.overallLeaderboard.map((r) => ({
    team: r.teamCompositionId,
    overall: r.overallScore,
    prelim: r.preliminary,
  }))
);

const rowA = dashboard.leaderboard.find(
  (r) => r.teamCompositionId === teamA.id
);
check(
  "leaderboard rows carry overallScore and equal-weighted trackBreakdown",
  rowA?.overallScore === 0.8 &&
    rowA?.trackBreakdown.length === 2 &&
    rowA.trackBreakdown.some(
      (t) => t.track === "gameiq" && t.averageVerifiedQuality === 1
    ) &&
    rowA.trackBreakdown.some(
      (t) => t.track === "workbench" && t.averageVerifiedQuality === 0.6
    ),
  rowA
);

check(
  "modelIntelligence full-table data stays intact (all models, per-track breakdown)",
  Array.isArray(dashboard.modelIntelligence) &&
    dashboard.modelIntelligence.length === 2 &&
    dashboard.modelIntelligence.every(
      (row) =>
        typeof row.combinedScore === "number" &&
        Array.isArray(row.tracks) &&
        row.tracks.every(
          (t) =>
            typeof t.track === "string" &&
            typeof t.averageVerifiedQuality === "number"
        )
    ),
  dashboard.modelIntelligence
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);

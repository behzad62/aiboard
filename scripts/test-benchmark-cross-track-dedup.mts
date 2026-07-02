/*
 * Cross-track double-count de-dup checks.
 * Run: npx tsx scripts/test-benchmark-cross-track-dedup.mts
 *
 * The same underlying decision can be scored into ONE merged (per-team)
 * leaderboard row twice via two tracks:
 *   (a) fireworks — a GameIQ fireworks scenario re-wraps a TeamIQ scenario and
 *       carries an explicit `source:<teamiq-id>` tag.
 *   (b) toolreliability — the TeamIQ ToolReliability suites run the SAME case
 *       ids as the dedicated solo ToolReliability track.
 * The merged row must count the shared decision once (keeping the richer,
 * track-primary sample) while per-track views still show both.
 */
import {
  aggregateCertifiedRunScores,
  dedupeCrossTrackAttempts,
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

function attempt(
  id: string,
  teamCompositionId: string,
  track: BenchmarkAttemptV2["track"],
  caseId: string,
  overrides: Partial<BenchmarkAttemptV2> = {}
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId,
    teamCompositionId,
    mode: "certified",
    track,
    harnessProfile: "aiboard-build-multi-worker",
    status: "passed",
    startedAt: "2026-07-02T10:00:00.000Z",
    completedAt: "2026-07-02T10:01:00.000Z",
    verifiedQuality: 0.9,
    jobSuccessScore: 90,
    efficiencyScore: 90,
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    modelCalls: 1,
    toolCalls: 1,
    durationMs: 1000,
    artifactIds: [],
    traceIds: [`trace-${id}`],
    failureIds: [],
    harnessVersion: "test",
    promptSetVersion: "test",
    scoringVersion: "certified-v0.1",
    ...overrides,
  };
}

function certifiedCase(
  id: string,
  track: BenchmarkCaseV2["track"],
  tags: string[] = []
): BenchmarkCaseV2 {
  return {
    id,
    schemaVersion: 2,
    track,
    title: id,
    description: `${track} case`,
    difficulty: "medium",
    tags,
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

// ---------------------------------------------------------------------------
// (a) fireworks source-tag overlap: gameiq case re-wraps teamiq scenario.
// The gameiq case carries source:<teamiq-scenario-id>; the teamiq attempt
// scores that same scenario id directly.
// ---------------------------------------------------------------------------
const gameiqFireworksCase = certifiedCase("gameiq-fireworks-basic-v1-01", "gameiq", [
  "fireworks",
  "solo-control",
  "source:fw-scenario-42",
]);
const teamiqFireworksCase = certifiedCase("fw-scenario-42", "teamiq");

const teamX = soloTeam("solo-x", "model:x");
const teamY = soloTeam("solo-y", "model:y");

const cases = [gameiqFireworksCase, teamiqFireworksCase];

const attempts: BenchmarkAttemptV2[] = [
  // Team X scores the SAME decision through both tracks.
  attempt("x-gameiq", teamX.id, "gameiq", gameiqFireworksCase.id),
  attempt("x-teamiq", teamX.id, "teamiq", teamiqFireworksCase.id),
  // Team Y only ran the GameIQ track -> must be unaffected by de-dup.
  attempt("y-gameiq", teamY.id, "gameiq", gameiqFireworksCase.id),
];

const dedup = dedupeCrossTrackAttempts(attempts, cases);
check(
  "de-dup collapses same-decision cross-track attempts for a team",
  dedup.filter((a) => a.teamCompositionId === teamX.id).length === 1,
  dedup.filter((a) => a.teamCompositionId === teamX.id)
);
check(
  "de-dup keeps the track-primary (gameiq) sample over teamiq re-wrap",
  dedup.some((a) => a.id === "x-gameiq") && !dedup.some((a) => a.id === "x-teamiq"),
  dedup.map((a) => a.id)
);
check(
  "gameiq-only team is unaffected by de-dup",
  dedup.filter((a) => a.teamCompositionId === teamY.id).length === 1,
  dedup.filter((a) => a.teamCompositionId === teamY.id)
);

// Merged leaderboard row for team X counts the shared decision once.
const leaderboard = aggregateCertifiedRunScores({
  attempts,
  cases,
  teamCompositions: [teamX, teamY],
  verifierResults: [],
});
const rowX = leaderboard.find((r) => r.teamCompositionId === teamX.id);
const rowY = leaderboard.find((r) => r.teamCompositionId === teamY.id);
check("merged leaderboard row counts shared decision once", rowX?.attempts === 1, rowX);
check(
  "merged row de-dup does not touch a single-track team",
  rowY?.attempts === 1,
  rowY
);

// Full dashboard: per-track trackRows keep BOTH samples; summary de-dups.
const dashboard = buildCertifiedBenchmarkDashboardData({
  caseV2: cases,
  attemptsV2: attempts,
  verifierResults: [],
  teamCompositions: [teamX, teamY],
  harnessCertifications: [],
});
const gameiqTrackRow = dashboard.trackRows.find((r) => r.track === "gameiq");
const teamiqTrackRow = dashboard.trackRows.find((r) => r.track === "teamiq");
check(
  "per-track gameiq view still counts both gameiq attempts",
  gameiqTrackRow?.attempts === 2,
  gameiqTrackRow
);
check(
  "per-track teamiq view still counts the teamiq attempt",
  teamiqTrackRow?.attempts === 1,
  teamiqTrackRow
);
// Summary verifiedPassRate is over deduped decisions: X counts once (both
// passed) + Y once = 2 merged decisions, all passed -> rate 1. Raw attempts
// would be 3, still rate 1, so assert on the deduped denominator via a mixed
// pass/fail below instead.

// ---------------------------------------------------------------------------
// (b) toolreliability shared-caseId overlap (no source tag; identical caseId).
// ---------------------------------------------------------------------------
const teamZ = soloTeam("solo-z", "model:z");
const sharedToolCaseId = "toolrel-current-json-schema-004";
const toolAttempts: BenchmarkAttemptV2[] = [
  attempt("z-solo-tool", teamZ.id, "toolreliability", sharedToolCaseId),
  attempt("z-teamiq-tool", teamZ.id, "teamiq", sharedToolCaseId),
];
const toolDedup = dedupeCrossTrackAttempts(toolAttempts, []);
check(
  "shared-caseId cross-track attempts de-dup to one",
  toolDedup.length === 1,
  toolDedup.map((a) => a.id)
);
check(
  "toolreliability wins over teamiq re-run for shared case id",
  toolDedup[0]?.id === "z-solo-tool",
  toolDedup.map((a) => a.id)
);

// ---------------------------------------------------------------------------
// Guards: different teams and different decisions must NOT collapse.
// ---------------------------------------------------------------------------
const crossTeam = dedupeCrossTrackAttempts(
  [
    attempt("a", "team-1", "gameiq", "case-shared"),
    attempt("b", "team-2", "teamiq", "case-shared"),
  ],
  []
);
check(
  "same decision across DIFFERENT teams is not collapsed",
  crossTeam.length === 2,
  crossTeam.map((a) => a.id)
);

const distinctDecisions = dedupeCrossTrackAttempts(
  [
    attempt("a", "team-1", "gameiq", "case-1"),
    attempt("b", "team-1", "teamiq", "case-2"),
  ],
  []
);
check(
  "distinct decisions within a team are both kept",
  distinctDecisions.length === 2,
  distinctDecisions.map((a) => a.id)
);

// Attempts with no case id are always passed through (cannot resolve identity).
const noCaseId = dedupeCrossTrackAttempts(
  [
    attempt("a", "team-1", "gameiq", ""),
    attempt("b", "team-1", "teamiq", ""),
  ],
  []
);
check(
  "attempts without a resolvable decision id are all kept",
  noCaseId.length === 2,
  noCaseId.map((a) => a.id)
);

// Same-track repeats of one decision are legitimate repetition and must all be
// kept (only CROSS-track duplicates collapse). Order-independent.
const repeatForward = dedupeCrossTrackAttempts(
  [
    attempt("aaa", "team-1", "teamiq", "case-tie"),
    attempt("bbb", "team-1", "teamiq", "case-tie"),
  ],
  []
);
const repeatReverse = dedupeCrossTrackAttempts(
  [
    attempt("bbb", "team-1", "teamiq", "case-tie"),
    attempt("aaa", "team-1", "teamiq", "case-tie"),
  ],
  []
);
check(
  "same-track repeats of one decision are all kept, order-independent",
  repeatForward.length === 2 && repeatReverse.length === 2,
  {
    repeatForward: repeatForward.map((a) => a.id),
    repeatReverse: repeatReverse.map((a) => a.id),
  }
);

// Cross-track winning track keeps ALL its repeats; losing track's are dropped.
const winnerKeepsRepeats = dedupeCrossTrackAttempts(
  [
    attempt("g1", "team-1", "gameiq", "case-multi"),
    attempt("g2", "team-1", "gameiq", "case-multi"),
    attempt("t1", "team-1", "teamiq", "case-multi"),
  ],
  []
);
check(
  "winning track keeps all repeats; losing track's samples are dropped",
  winnerKeepsRepeats.length === 2 &&
    winnerKeepsRepeats.every((a) => a.track === "gameiq"),
  winnerKeepsRepeats.map((a) => `${a.id}:${a.track}`)
);

// Summary de-dup denominator check with a mixed pass/fail so the deduped
// denominator is observable: team X's teamiq sample FAILS but is dropped in
// favor of the passing gameiq sample -> merged pass rate must be 1, not 0.5.
const mixedAttempts: BenchmarkAttemptV2[] = [
  attempt("m-gameiq", teamX.id, "gameiq", gameiqFireworksCase.id, {
    status: "passed",
  }),
  attempt("m-teamiq", teamX.id, "teamiq", teamiqFireworksCase.id, {
    status: "failed_model",
    verifiedQuality: 0.1,
    efficiencyScore: 10,
  }),
];
const mixedDashboard = buildCertifiedBenchmarkDashboardData({
  caseV2: cases,
  attemptsV2: mixedAttempts,
  verifierResults: [],
  teamCompositions: [teamX],
  harnessCertifications: [],
});
check(
  "summary pass rate uses deduped decisions (drops teamiq re-wrap sample)",
  mixedDashboard.summary.verifiedPassRate === 1,
  mixedDashboard.summary.verifiedPassRate
);
check(
  "summary quality uses the track-primary (gameiq) sample, not the average",
  mixedDashboard.summary.averageVerifiedQuality === 0.9,
  mixedDashboard.summary.averageVerifiedQuality
);
check(
  "certifiedAttempts count stays a raw attempt count (not deduped)",
  mixedDashboard.summary.certifiedAttempts === 2 &&
    mixedDashboard.summary.scoredAttempts === 2,
  {
    certifiedAttempts: mixedDashboard.summary.certifiedAttempts,
    scoredAttempts: mixedDashboard.summary.scoredAttempts,
  }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

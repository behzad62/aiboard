/* TeamIQ recommendation UI data checks (run: npx tsx scripts/test-teamiq-recommendations.mts) */
import {
  buildTeamIqComboMatrixRows,
  buildTeamIqRecommendationCards,
  deriveSoloTeamComposition,
  deriveTeamComposition,
} from "../lib/benchmark/teamiq";
import { buildCertifiedBenchmarkDashboardData } from "../lib/benchmark/metrics";
import type {
  BenchmarkAttemptV2,
  BenchmarkTeamCompositionRole,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const at = "2026-06-28T10:00:00.000Z";
const architect: BenchmarkTeamCompositionRole = {
  role: "architect",
  slot: "architect",
  modelId: "openai:gpt-team",
  providerId: "openai",
  displayName: "GPT Team",
  temperature: 0,
};
const worker: BenchmarkTeamCompositionRole = {
  role: "worker",
  slot: "worker",
  modelId: "google:gemini-team",
  providerId: "google",
  displayName: "Gemini Team",
  temperature: 0,
};
const reviewer: BenchmarkTeamCompositionRole = {
  role: "reviewer",
  slot: "reviewer",
  modelId: "anthropic:claude-team",
  providerId: "anthropic",
  displayName: "Claude Team",
  temperature: 0,
};

const soloArchitect = deriveSoloTeamComposition({
  modelId: architect.modelId,
  providerId: architect.providerId,
  displayName: architect.displayName,
});
const soloWorker = deriveSoloTeamComposition({
  modelId: worker.modelId,
  providerId: worker.providerId,
  displayName: worker.displayName,
});
const soloReviewer = deriveSoloTeamComposition({
  modelId: reviewer.modelId,
  providerId: reviewer.providerId,
  displayName: reviewer.displayName,
});
const strongTeam = deriveTeamComposition({
  name: "Strong team",
  roles: [architect, worker, reviewer],
});
const watchTeam = deriveTeamComposition({
  name: "Watch team",
  roles: [architect, reviewer],
});

const teamCompositions = [
  soloArchitect,
  soloWorker,
  soloReviewer,
  strongTeam,
  watchTeam,
];
const attempts = [
  attempt("solo-architect", soloArchitect.id, 70, 0.7, 0.5, 30_000),
  attempt("solo-worker", soloWorker.id, 62, 0.62, 0.2, 20_000),
  attempt("solo-reviewer", soloReviewer.id, 72, 0.72, 0.7, 35_000),
  attempt("strong-team", strongTeam.id, 88, 0.88, 1, 25_000),
  attempt("watch-team", watchTeam.id, 65, 0.65, 2, 60_000),
];

const rows = buildTeamIqComboMatrixRows({
  attempts,
  teamCompositions,
  track: "teamiq",
});
const cards = buildTeamIqRecommendationCards(rows);

check("TeamIQ recommendation cards include best team lift", cards.some((card) => card.kind === "best_team_lift" && card.teamCompositionId === strongTeam.id), cards);
check("TeamIQ recommendation cards include best quality", cards.some((card) => card.kind === "best_quality" && card.teamCompositionId === strongTeam.id), cards);
check("TeamIQ recommendation cards include watchlist", cards.some((card) => card.kind === "watchlist" && card.teamCompositionId === watchTeam.id), cards);
check("TeamIQ recommendation cards expose concise values", cards.every((card) => card.title && card.value && card.detail), cards);

const dashboard = buildCertifiedBenchmarkDashboardData({
  caseV2: [
    {
      id: "case-teamiq",
      schemaVersion: 2,
      track: "teamiq",
      title: "TeamIQ case",
      description: "TeamIQ case",
      difficulty: "medium",
      tags: ["teamiq"],
      caseVersion: "1.0.0",
      createdAt: at,
      updatedAt: at,
      prompt: { userRequest: "Run TeamIQ." },
      environment: { type: "browser", timeoutSeconds: 60, network: "none" },
      verifier: { scorer: "rule-checker" },
      budget: {},
      scoring: { scoringVersion: "teamiq-test", primary: "team_lift" },
      contamination: {
        originalTask: true,
        canary: "AIBENCH-TEAMIQ-RECS",
        referenceSolutionPrivate: true,
      },
    },
  ],
  attemptsV2: attempts,
  verifierResults: [],
  teamCompositions,
  harnessCertifications: [],
});

check(
  "certified dashboard exposes TeamIQ combo matrix rows",
  dashboard.teamIqComboMatrixRows.length === rows.length &&
    dashboard.teamIqComboMatrixRows.some((row) => row.teamCompositionId === strongTeam.id),
  dashboard.teamIqComboMatrixRows
);
check(
  "certified dashboard exposes TeamIQ recommendation cards",
  dashboard.teamIqRecommendationCards.some((card) => card.kind === "best_team_lift"),
  dashboard.teamIqRecommendationCards
);

function attempt(
  id: string,
  teamCompositionId: string,
  jobSuccessScore: number,
  verifiedQuality: number,
  costUsd: number,
  durationMs: number
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId: "case-teamiq",
    teamCompositionId,
    mode: "certified",
    track: "teamiq",
    harnessProfile: "aiboard-build-multi-worker",
    status: "passed",
    startedAt: at,
    completedAt: at,
    verifiedQuality,
    jobSuccessScore,
    efficiencyScore: jobSuccessScore,
    costUsd,
    inputTokens: 100,
    outputTokens: 50,
    modelCalls: 1,
    toolCalls: 0,
    durationMs,
    artifactIds: [],
    traceIds: [`${id}:trace`],
    failureIds: [],
    harnessVersion: "teamiq-test-harness",
    promptSetVersion: "teamiq-test-prompts",
    scoringVersion: "teamiq-test-scoring",
  };
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

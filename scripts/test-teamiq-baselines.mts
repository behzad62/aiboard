/* TeamIQ baseline checks (run: npx tsx scripts/test-teamiq-baselines.mts) */
import {
  __resetBenchmarkStoreForTests,
  listBenchmarkTeamCompositions,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import {
  deriveSoloTeamComposition,
  deriveTeamComposition,
  linkTeamLiftBaselines,
  planTeamIqExperiment,
  TEAM_IQ_STRATEGIES,
} from "../lib/benchmark/teamiq";
import type {
  BenchmarkAttemptV2,
  BenchmarkTeamComposition,
  BenchmarkTeamCompositionRole,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const createdAt = "2026-06-27T10:00:00.000Z";

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
  slot: "worker-1",
  modelId: "google:gemini-test",
  providerId: "google",
  displayName: "Gemini Test",
  temperature: 0.2,
};

const soloGpt = deriveSoloTeamComposition({
  modelId: "openai:gpt-test",
  displayName: "GPT Test",
  temperature: 0,
});
const soloGemini = deriveSoloTeamComposition({
  modelId: "google:gemini-test",
  displayName: "Gemini Test",
  temperature: 0.2,
});
const team = deriveTeamComposition({
  name: "GPT architect plus Gemini worker",
  roles: [gptRole, geminiRole],
});

__resetBenchmarkStoreForTests();
await saveBenchmarkTeamComposition(soloGpt);
await saveBenchmarkTeamComposition(soloGemini);
await saveBenchmarkTeamComposition(team);

const saved = await listBenchmarkTeamCompositions();
check("TeamIQ compositions save through benchmark store", saved.length === 3, saved);
check("solo composition derives a stable solo role", soloGpt.roles[0]?.role === "single" && soloGpt.roles[0]?.slot === "single", soloGpt);
check(
  "team composition derives a stable combo hash",
  team.comboHash ===
    deriveTeamComposition({
      name: "GPT architect plus Gemini worker",
      roles: [gptRole, geminiRole],
    }).comboHash,
  team
);

const teamById = new Map<string, BenchmarkTeamComposition>(
  saved.map((composition) => [composition.id, composition])
);

const gptSoloAttempt = attempt({
  id: "solo-gpt-case-1",
  caseId: "case-1",
  teamCompositionId: soloGpt.id,
  harnessProfile: "raw-single-model",
  jobSuccessScore: 74,
  verifiedQuality: 0.74,
  costUsd: 0.8,
  durationMs: 60_000,
});

const geminiSoloAttempt = attempt({
  id: "solo-gemini-case-1",
  caseId: "case-1",
  teamCompositionId: soloGemini.id,
  harnessProfile: "raw-single-model",
  jobSuccessScore: 60,
  verifiedQuality: 0.6,
  costUsd: 0.4,
  durationMs: 40_000,
});

const unrelatedSoloAttempt = attempt({
  id: "solo-gpt-case-2",
  caseId: "case-2",
  teamCompositionId: soloGpt.id,
  harnessProfile: "raw-single-model",
  jobSuccessScore: 99,
  verifiedQuality: 0.99,
  costUsd: 0.1,
  durationMs: 10_000,
});
const wrongHarnessSoloAttempt = attempt({
  id: "solo-gpt-case-1-wrong-harness",
  caseId: "case-1",
  teamCompositionId: soloGpt.id,
  harnessProfile: "raw-single-model",
  jobSuccessScore: 99,
  verifiedQuality: 0.99,
  costUsd: 0.1,
  durationMs: 10_000,
  harnessVersion: "other-harness",
});
const wrongScoringSoloAttempt = attempt({
  id: "solo-gemini-case-1-wrong-scoring",
  caseId: "case-1",
  teamCompositionId: soloGemini.id,
  harnessProfile: "raw-single-model",
  jobSuccessScore: 99,
  verifiedQuality: 0.99,
  costUsd: 0.1,
  durationMs: 10_000,
  scoringVersion: "other-scoring",
});

const teamAttempt = attempt({
  id: "team-case-1",
  caseId: "case-1",
  teamCompositionId: team.id,
  harnessProfile: "aiboard-build-multi-worker",
  jobSuccessScore: 84,
  verifiedQuality: 0.84,
  costUsd: 1,
  durationMs: 50_000,
});

const partialLinks = linkTeamLiftBaselines({
  soloAttempts: [gptSoloAttempt],
  teamAttempts: [teamAttempt],
  teamCompositions: Array.from(teamById.values()),
});

check(
  "team lift requires solo baselines for every team member",
  partialLinks.length === 0,
  partialLinks
);

const versionMismatchLinks = linkTeamLiftBaselines({
  soloAttempts: [wrongHarnessSoloAttempt, wrongScoringSoloAttempt],
  teamAttempts: [teamAttempt],
  teamCompositions: Array.from(teamById.values()),
});

check(
  "team lift requires matching harness and scoring versions",
  versionMismatchLinks.length === 0,
  versionMismatchLinks
);

const links = linkTeamLiftBaselines({
  soloAttempts: [gptSoloAttempt, geminiSoloAttempt, unrelatedSoloAttempt],
  teamAttempts: [teamAttempt],
  teamCompositions: Array.from(teamById.values()),
});

check("solo baselines link by team member and case", links.length === 1 && links[0]?.memberSoloAttempts.length === 2, links);
check("best solo baseline ignores unrelated cases", links[0]?.bestSoloAttempt?.id === "solo-gpt-case-1", links[0]);
check(
  "team lift is computed through scoreTeamLift",
  links[0]?.score.teamLift === 10 &&
    links[0]?.score.bestSoloScore === 74 &&
    links[0]?.score.costAdjustedTeamLift === 8 &&
    links[0]?.score.speedAdjustedTeamLift === 12,
  links[0]?.score
);

const experiment = planTeamIqExperiment({
  architectCandidates: [
    {
      modelId: "openai:gpt-test",
      providerId: "openai",
      displayName: "GPT Test",
    },
  ],
  workerCandidates: [
    {
      modelId: "google:gemini-test",
      providerId: "google",
      displayName: "Gemini Test",
    },
    {
      modelId: "anthropic:claude-test",
      providerId: "anthropic",
      displayName: "Claude Test",
    },
  ],
  reviewerCandidates: [
    {
      modelId: "openai:gpt-test",
      providerId: "openai",
      displayName: "GPT Test",
    },
  ],
  includeSoloBaselines: true,
  maxCombos: 2,
});

check(
  "TeamIQ experiment planner creates solo baselines for unique candidates",
  experiment.soloCompositions.length === 3 &&
    experiment.soloCompositions.every((composition) => composition.roles[0]?.role === "single"),
  experiment.soloCompositions
);
check(
  "TeamIQ experiment planner creates bounded architect-worker-reviewer teams",
  experiment.teamCompositions.length === 2 &&
    experiment.teamCompositions.every((composition) =>
      ["architect", "worker", "reviewer"].every((role) =>
        composition.roles.some((item) => item.role === role)
      )
    ),
  experiment.teamCompositions
);

const strategyExperiment = planTeamIqExperiment({
  architectCandidates: [
    {
      modelId: "openai:gpt-test",
      providerId: "openai",
      displayName: "GPT Test",
    },
  ],
  workerCandidates: [
    {
      modelId: "google:gemini-test",
      providerId: "google",
      displayName: "Gemini Test",
    },
    {
      modelId: "anthropic:claude-test",
      providerId: "anthropic",
      displayName: "Claude Test",
    },
  ],
  reviewerCandidates: [
    {
      modelId: "openai:gpt-test",
      providerId: "openai",
      displayName: "GPT Test",
    },
  ],
  includeSoloBaselines: false,
  strategies: TEAM_IQ_STRATEGIES,
  maxCombos: 20,
});
const plannedStrategies = new Set([
  ...strategyExperiment.soloCompositions.map((composition) => composition.strategy),
  ...strategyExperiment.teamCompositions.map((composition) => composition.strategy),
]);
check(
  "TeamIQ experiment planner exposes every supported strategy",
  TEAM_IQ_STRATEGIES.every((strategy) => plannedStrategies.has(strategy)),
  { plannedStrategies: [...plannedStrategies], teamCompositions: strategyExperiment.teamCompositions }
);
check(
  "TeamIQ experiment planner maps named strategies to expected role shapes",
  strategyExperiment.teamCompositions.some(
    (composition) =>
      composition.strategy === "panel" &&
      composition.roles.length >= 2 &&
      composition.roles.every((role) => role.role === "specialist")
  ) &&
    strategyExperiment.teamCompositions.some(
      (composition) =>
        composition.strategy === "debate" &&
        composition.roles.some((role) => role.role === "critic") &&
        composition.roles.some((role) => role.role === "judge")
    ) &&
    strategyExperiment.teamCompositions.some(
      (composition) =>
        composition.strategy === "cheap_swarm_strong_judge" &&
        composition.roles.filter((role) => role.role === "worker").length >= 2 &&
        composition.roles.some((role) => role.role === "judge")
    ),
  strategyExperiment.teamCompositions
);

function attempt(
  overrides: Partial<BenchmarkAttemptV2> & {
    id: string;
    caseId: string;
    teamCompositionId: string;
    harnessProfile: BenchmarkAttemptV2["harnessProfile"];
  }
): BenchmarkAttemptV2 {
  return {
    id: overrides.id,
    runId: `run-${overrides.id}`,
    caseId: overrides.caseId,
    teamCompositionId: overrides.teamCompositionId,
    mode: "certified",
    track: "teamiq",
    harnessProfile: overrides.harnessProfile,
    status: "passed",
    startedAt: createdAt,
    completedAt: createdAt,
    verifiedQuality: overrides.verifiedQuality ?? 0,
    jobSuccessScore: overrides.jobSuccessScore ?? 0,
    efficiencyScore: overrides.efficiencyScore ?? 0,
    teamLift: overrides.teamLift,
    costUsd: overrides.costUsd ?? null,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: overrides.durationMs ?? 0,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: overrides.harnessVersion ?? "test-harness",
    promptSetVersion: "test-prompts",
    scoringVersion: overrides.scoringVersion ?? "test-scoring",
  };
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

/* TeamIQ UI selection checks (run: npx tsx scripts/test-teamiq-ui-selection.mts) */
import {
  TEAMIQ_TOOL_BENCH_STRATEGIES,
  createTeamIqCompositionFromSelection,
  createTeamIqToolBenchCompositionsFromSelection,
  deriveSoloTeamComposition,
  isSoloTeamComposition,
  linkTeamLiftBaselines,
  normalizeTeamIqModelSelectionForSlots,
  teamIqRoleSlotsForStrategy,
} from "../lib/benchmark/teamiq";
import type { BenchmarkAttemptV2 } from "../lib/benchmark/types";
import type { SelectedModel } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const models: SelectedModel[] = [
  {
    providerId: "openai",
    modelId: "openai:gpt-team-architect",
    displayName: "GPT Team Architect",
  },
  {
    providerId: "google",
    modelId: "google:gemini-team-worker",
    displayName: "Gemini Team Worker",
  },
  {
    providerId: "anthropic",
    modelId: "anthropic:claude-team-reviewer",
    displayName: "Claude Team Reviewer",
  },
];

const architectWorkerReviewerSlots = teamIqRoleSlotsForStrategy(
  "architect_worker_reviewer"
);
check(
  "TeamIQ UI exposes explicit architect-worker-reviewer role slots",
  JSON.stringify(
    architectWorkerReviewerSlots.map((slot) => [
      slot.role,
      slot.slot,
      slot.label,
    ])
  ) ===
    JSON.stringify([
      ["architect", "01-architect", "Architect"],
      ["worker", "02-worker", "Worker"],
      ["reviewer", "03-reviewer", "Reviewer"],
    ]),
  architectWorkerReviewerSlots
);

const explicitRoleTeam = createTeamIqCompositionFromSelection({
  models,
  selectedModelIds: [models[0].modelId],
  strategy: "architect_worker_reviewer",
  roleAssignments: [
    {
      role: "architect",
      slot: "01-architect",
      modelId: models[2].modelId,
    },
    {
      role: "worker",
      slot: "02-worker",
      modelId: models[0].modelId,
    },
    {
      role: "reviewer",
      slot: "03-reviewer",
      modelId: models[1].modelId,
    },
  ],
} as Parameters<typeof createTeamIqCompositionFromSelection>[0] & {
  roleAssignments: Array<{
    role: "architect" | "worker" | "reviewer";
    slot: string;
    modelId: string;
  }>;
});
check(
  "TeamIQ UI selection honors explicit role-to-model assignments",
  explicitRoleTeam.roles[0]?.role === "architect" &&
    explicitRoleTeam.roles[0]?.modelId === models[2].modelId &&
    explicitRoleTeam.roles[1]?.role === "worker" &&
    explicitRoleTeam.roles[1]?.modelId === models[0].modelId &&
    explicitRoleTeam.roles[2]?.role === "reviewer" &&
    explicitRoleTeam.roles[2]?.modelId === models[1].modelId,
  explicitRoleTeam
);

check(
  "TeamIQ slot selection normalization expands to the visible slot count",
  JSON.stringify(
    normalizeTeamIqModelSelectionForSlots({
      models,
      selectedModelIds: [models[0].modelId],
      slotCount: 3,
    })
  ) ===
    JSON.stringify([
      models[0].modelId,
      models[0].modelId,
      models[0].modelId,
    ]),
  normalizeTeamIqModelSelectionForSlots({
    models,
    selectedModelIds: [models[0].modelId],
    slotCount: 3,
  })
);

check(
  "TeamIQ slot selection normalization removes stale model ids",
  JSON.stringify(
    normalizeTeamIqModelSelectionForSlots({
      models,
      selectedModelIds: ["missing-model", models[1].modelId],
      slotCount: 2,
    })
  ) === JSON.stringify([models[0].modelId, models[1].modelId]),
  normalizeTeamIqModelSelectionForSlots({
    models,
    selectedModelIds: ["missing-model", models[1].modelId],
    slotCount: 2,
  })
);

const team = createTeamIqCompositionFromSelection({
  models,
  selectedModelIds: models.map((model) => model.modelId),
});
check(
  "TeamIQ UI selection creates architect-worker-reviewer team",
  team.roles[0]?.role === "architect" &&
    team.roles[1]?.role === "worker" &&
    team.roles[2]?.role === "reviewer",
  team
);
check(
  "TeamIQ UI selection preserves provider and display labels",
  team.roles.every((role, index) => role.providerId === models[index].providerId) &&
    team.name.includes("GPT Team Architect") &&
    team.name.includes("Gemini Team Worker"),
  team
);

const oneModelTeam = createTeamIqCompositionFromSelection({
  models,
  selectedModelIds: [models[0].modelId],
  strategy: "architect_worker",
});
const oneModelSolo = deriveSoloTeamComposition({
  modelId: models[0].modelId,
  providerId: models[0].providerId,
  displayName: models[0].displayName,
});
check(
  "TeamIQ UI selection can reuse one model across architect and worker roles",
  oneModelTeam.roles.length === 2 &&
    oneModelTeam.roles[0]?.role === "architect" &&
    oneModelTeam.roles[1]?.role === "worker" &&
    oneModelTeam.roles.every((role) => role.modelId === models[0].modelId),
  oneModelTeam
);
check(
  "TeamIQ role-reused one-model team is not classified as solo",
  !isSoloTeamComposition(oneModelTeam) && isSoloTeamComposition(oneModelSolo),
  oneModelTeam
);
const oneModelLiftLinks = linkTeamLiftBaselines({
  soloAttempts: [attemptForTeam(oneModelSolo.id, 60, "solo-one-model")],
  teamAttempts: [attemptForTeam(oneModelTeam.id, 80, "team-one-model")],
  teamCompositions: [oneModelSolo, oneModelTeam],
  track: "teamiq",
});
check(
  "TeamIQ role-reused one-model team links against its solo baseline",
  oneModelLiftLinks.length === 1 &&
    oneModelLiftLinks[0]?.memberSoloAttempts.length === 1 &&
    oneModelLiftLinks[0]?.score.teamLift > 0,
  oneModelLiftLinks
);

const debateTeam = createTeamIqCompositionFromSelection({
  models,
  selectedModelIds: models.map((model) => model.modelId),
  strategy: "debate",
});
check(
  "TeamIQ UI selection creates debate teams with judge",
  debateTeam.strategy === "debate" &&
    debateTeam.roles.filter((role) => role.role === "critic").length === 2 &&
    debateTeam.roles.some((role) => role.role === "judge"),
  debateTeam
);

const swarmTeam = createTeamIqCompositionFromSelection({
  models,
  selectedModelIds: models.map((model) => model.modelId),
  strategy: "cheap_swarm_strong_judge",
});
check(
  "TeamIQ UI selection creates cheap swarm strong judge teams",
  swarmTeam.strategy === "cheap_swarm_strong_judge" &&
    swarmTeam.roles.filter((role) => role.role === "worker").length === 2 &&
    swarmTeam.roles.some((role) => role.role === "judge"),
  swarmTeam
);

const fireworksTeam = createTeamIqCompositionFromSelection({
  models,
  selectedModelIds: models.map((model) => model.modelId),
  roleMode: "fireworks_players",
} as Parameters<typeof createTeamIqCompositionFromSelection>[0]);
check(
  "TeamIQ UI selection can create Fireworks player slots",
  fireworksTeam.roles[0]?.role === "player" &&
    fireworksTeam.roles[0]?.slot === "P1" &&
    fireworksTeam.roles[1]?.role === "player" &&
    fireworksTeam.roles[1]?.slot === "P2" &&
    fireworksTeam.roles[2]?.role === "player" &&
    fireworksTeam.roles[2]?.slot === "P3",
  fireworksTeam
);

let underfilledFireworksRejected = false;
try {
  createTeamIqCompositionFromSelection({
    models,
    selectedModelIds: models.slice(0, 2).map((model) => model.modelId),
    roleMode: "fireworks_players",
    playerCount: 3,
  } as Parameters<typeof createTeamIqCompositionFromSelection>[0]);
} catch {
  underfilledFireworksRejected = true;
}
check(
  "TeamIQ UI selection rejects underfilled 3-player Fireworks teams",
  underfilledFireworksRejected
);

const toolBenchTeams = createTeamIqToolBenchCompositionsFromSelection({
  models,
  selectedModelIds: models.slice(0, 2).map((model) => model.modelId),
});
check(
  "TeamIQ tool bench selection creates every strategy mode",
  toolBenchTeams.length === TEAMIQ_TOOL_BENCH_STRATEGIES.length &&
    TEAMIQ_TOOL_BENCH_STRATEGIES.every((strategy) =>
      toolBenchTeams.some((candidate) => candidate.strategy === strategy)
    ),
  toolBenchTeams
);
check(
  "TeamIQ tool bench all-mode selection keeps distinct team ids",
  new Set(toolBenchTeams.map((candidate) => candidate.id)).size ===
    toolBenchTeams.length,
  toolBenchTeams.map((candidate) => ({
    id: candidate.id,
    strategy: candidate.strategy,
    roles: candidate.roles.map((role) => role.role),
  }))
);

const oneModelToolBenchTeams = createTeamIqToolBenchCompositionsFromSelection({
  models,
  selectedModelIds: [models[0].modelId],
});
check(
  "TeamIQ tool bench all-mode selection supports one selected model",
  oneModelToolBenchTeams.length === TEAMIQ_TOOL_BENCH_STRATEGIES.length &&
    oneModelToolBenchTeams.every(
      (candidate) =>
        !isSoloTeamComposition(candidate) &&
        candidate.roles.length >= 2 &&
        candidate.roles.every((role) => role.modelId === models[0].modelId)
    ),
  oneModelToolBenchTeams
);
check(
  "TeamIQ tool bench strategies use fixed consolidated role shapes",
  JSON.stringify(
    Object.fromEntries(
      oneModelToolBenchTeams.map((candidate) => [
        candidate.strategy,
        candidate.roles.map((role) => role.role),
      ])
    )
  ) ===
    JSON.stringify({
      panel: ["specialist", "specialist", "specialist"],
      debate: ["critic", "critic", "judge"],
      architect_worker: ["architect", "worker"],
      architect_worker_reviewer: ["architect", "worker", "reviewer"],
      cheap_swarm_strong_judge: ["worker", "worker", "judge"],
    }),
  oneModelToolBenchTeams.map((candidate) => ({
    strategy: candidate.strategy,
    roles: candidate.roles.map((role) => role.role),
  }))
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

function attemptForTeam(
  teamCompositionId: string,
  score: number,
  id: string
): BenchmarkAttemptV2 {
  return {
    id,
    runId: "test-run",
    caseId: "test-case",
    teamCompositionId,
    mode: "certified",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: "2026-06-30T00:00:00.000Z",
    completedAt: "2026-06-30T00:00:01.000Z",
    verifiedQuality: score / 100,
    jobSuccessScore: score,
    efficiencyScore: score,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1000,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "teamiq-runner-v0.1",
    promptSetVersion: "test",
    scoringVersion: "teamiq-toolreliability-current",
  };
}

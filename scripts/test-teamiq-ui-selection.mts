/* TeamIQ UI selection checks (run: npx tsx scripts/test-teamiq-ui-selection.mts) */
import { createTeamIqCompositionFromSelection } from "../lib/benchmark/teamiq";
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

let singleModelRejected = false;
try {
  createTeamIqCompositionFromSelection({
    models,
    selectedModelIds: [models[0].modelId],
  });
} catch {
  singleModelRejected = true;
}
check("TeamIQ UI selection rejects one-model teams", singleModelRejected);

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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
